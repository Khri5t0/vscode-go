/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/
import {
	CancellationToken,
	Location,
	OutputChannel,
	Position,
	TestController,
	TestItem,
	TestMessage,
	TestRun,
	TestRunRequest,
	Uri
} from 'vscode';
import vscode = require('vscode');
import path = require('path');
import { isModSupported } from '../goModules';
import { getGoConfig } from '../config';
import { getTestFlags, goTest, GoTestOutput } from '../testUtils';
import { GoTestResolver } from './resolve';
import { dispose, forEachAsync, GoTest, Workspace } from './utils';

type CollectedTest = { item: TestItem; explicitlyIncluded?: boolean };

// TestRunOutput is a fake OutputChannel that forwards all test output to the test API
// console.
class TestRunOutput implements OutputChannel {
	readonly name: string;
	readonly lines: string[] = [];

	constructor(private run: TestRun) {
		this.name = `Test run at ${new Date()}`;
	}

	append(value: string) {
		this.run.appendOutput(value);
	}

	appendLine(value: string) {
		this.lines.push(value);
		this.run.appendOutput(value + '\r\n');
	}

	clear() {}
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	show(...args: unknown[]) {}
	hide() {}
	dispose() {}
}

export class GoTestRunner {
	constructor(
		private readonly workspace: Workspace,
		private readonly ctrl: TestController,
		private readonly resolver: GoTestResolver
	) {}

	// Execute tests - TestController.runTest callback
	async run(request: TestRunRequest, token: CancellationToken) {
		const collected = new Map<TestItem, CollectedTest[]>();
		const files = new Set<TestItem>();
		if (request.include) {
			for (const item of request.include) {
				await this.collectTests(item, true, request.exclude || [], collected, files);
			}
		} else {
			const promises: Promise<unknown>[] = [];
			this.ctrl.items.forEach((item) => {
				const p = this.collectTests(item, true, request.exclude || [], collected, files);
				promises.push(p);
			});
			await Promise.all(promises);
		}

		// Save all documents that contain a test we're about to run, to ensure `go
		// test` has the latest changes
		const fileUris = new Set(Array.from(files).map((x) => x.uri));
		await Promise.all(this.workspace.textDocuments.filter((x) => fileUris.has(x.uri)).map((x) => x.save()));

		let hasBench = false,
			hasNonBench = false;
		for (const items of collected.values()) {
			for (const { item } of items) {
				const { kind } = GoTest.parseId(item.id);
				if (kind === 'benchmark') hasBench = true;
				else hasNonBench = true;
			}
		}

		function isInMod(item: TestItem): boolean {
			const { kind } = GoTest.parseId(item.id);
			if (kind === 'module') return true;
			if (!item.parent) return false;
			return isInMod(item.parent);
		}

		const run = this.ctrl.createTestRun(request);
		const outputChannel = new TestRunOutput(run);
		for (const [pkg, items] of collected.entries()) {
			const isMod = isInMod(pkg) || (await isModSupported(pkg.uri, true));
			const goConfig = getGoConfig(pkg.uri);
			const flags = getTestFlags(goConfig);
			const includeBench = getGoConfig(pkg.uri).get('testExplorerRunBenchmarks');

			// If any of the tests are test suite methods, add all test functions that call `suite.Run`
			const hasTestMethod = items.some(({ item }) => this.resolver.isTestMethod.has(item));
			if (hasTestMethod) {
				const add: TestItem[] = [];
				pkg.children.forEach((file) => {
					file.children.forEach((test) => {
						if (!this.resolver.isTestSuiteFunc.has(test)) return;
						if (items.some(({ item }) => item === test)) return;
						add.push(test);
					});
				});
				items.push(...add.map((item) => ({ item })));
			}

			// Separate tests and benchmarks and mark them as queued for execution.
			// Clear any sub tests/benchmarks generated by a previous run.
			const tests: Record<string, TestItem> = {};
			const benchmarks: Record<string, TestItem> = {};
			for (const { item, explicitlyIncluded } of items) {
				const { kind, name } = GoTest.parseId(item.id);
				if (/[/#]/.test(name)) {
					// running sub-tests is not currently supported
					vscode.window.showErrorMessage(`Cannot run ${name} - running sub-tests is not supported`);
					continue;
				}

				// When the user clicks the run button on a package, they expect all
				// of the tests within that package to run - they probably don't
				// want to run the benchmarks. So if a benchmark is not explicitly
				// selected, don't run benchmarks. But the user may disagree, so
				// behavior can be changed with `go.testExplorerRunBenchmarks`.
				// However, if the user clicks the run button on a file or package
				// that contains benchmarks and nothing else, they likely expect
				// those benchmarks to run.
				if (kind === 'benchmark' && !explicitlyIncluded && !includeBench && !(hasBench && !hasNonBench)) {
					continue;
				}

				item.error = null;
				run.enqueued(item);

				// Remove subtests created dynamically from test output
				item.children.forEach((child) => {
					if (this.resolver.isDynamicSubtest.has(child)) {
						dispose(child);
					}
				});

				if (kind === 'benchmark') {
					benchmarks[name] = item;
				} else {
					tests[name] = item;
				}
			}

			const record = new Map<TestItem, string[]>();
			const testFns = Object.keys(tests);
			const benchmarkFns = Object.keys(benchmarks);
			const concat = goConfig.get<boolean>('testExplorerConcatenateMessages');

			// Run tests
			if (testFns.length > 0) {
				const complete = new Set<TestItem>();
				const success = await goTest({
					goConfig,
					flags,
					isMod,
					outputChannel,
					dir: pkg.uri.fsPath,
					functions: testFns,
					cancel: token,
					goTestOutputConsumer: (e) => this.consumeGoTestEvent(run, tests, record, complete, concat, e)
				});
				if (!success) {
					if (this.isBuildFailure(outputChannel.lines)) {
						this.markComplete(tests, new Set(), (item) => {
							run.errored(item, { message: 'Compilation failed' });
							item.error = 'Compilation failed';
						});
					} else {
						this.markComplete(tests, complete, (x) => run.skipped(x));
					}
				}
			}

			// Run benchmarks
			if (benchmarkFns.length > 0) {
				const complete = new Set<TestItem>();
				const success = await goTest({
					goConfig,
					flags,
					isMod,
					outputChannel,
					dir: pkg.uri.fsPath,
					functions: benchmarkFns,
					isBenchmark: true,
					cancel: token,
					goTestOutputConsumer: (e) => this.consumeGoBenchmarkEvent(run, benchmarks, complete, e)
				});

				// Explicitly complete any incomplete benchmarks (see test_events.md)
				if (success) {
					this.markComplete(benchmarks, complete, (x) => run.passed(x));
				} else if (this.isBuildFailure(outputChannel.lines)) {
					this.markComplete(benchmarks, new Set(), (item) => {
						// TODO change to errored when that is added back
						run.failed(item, { message: 'Compilation failed' });
						item.error = 'Compilation failed';
					});
				} else {
					this.markComplete(benchmarks, complete, (x) => run.skipped(x));
				}
			}
		}

		run.end();
	}

	// Recursively find all tests, benchmarks, and examples within a
	// module/package/etc, minus exclusions. Map tests to the package they are
	// defined in, and track files.
	async collectTests(
		item: TestItem,
		explicitlyIncluded: boolean,
		excluded: TestItem[],
		functions: Map<TestItem, CollectedTest[]>,
		files: Set<TestItem>
	) {
		for (let i = item; i.parent; i = i.parent) {
			if (excluded.indexOf(i) >= 0) {
				return;
			}
		}

		const { name } = GoTest.parseId(item.id);
		if (!name) {
			if (item.children.size === 0) {
				await this.resolver.resolve(item);
			}

			await forEachAsync(item.children, (child) => {
				return this.collectTests(child, false, excluded, functions, files);
			});
			return;
		}

		function getFile(item: TestItem): TestItem {
			const { kind } = GoTest.parseId(item.id);
			if (kind === 'file') return item;
			return getFile(item.parent);
		}

		const file = getFile(item);
		files.add(file);

		const pkg = file.parent;
		if (functions.has(pkg)) {
			functions.get(pkg).push({ item, explicitlyIncluded });
		} else {
			functions.set(pkg, [{ item, explicitlyIncluded }]);
		}
		return;
	}

	// Resolve a test name to a test item. If the test name is TestXxx/Foo, Foo is
	// created as a child of TestXxx. The same is true for TestXxx#Foo and
	// TestXxx/#Foo.
	resolveTestName(tests: Record<string, TestItem>, name: string): TestItem | undefined {
		if (!name) {
			return;
		}

		const parts = name.split(/[#/]+/);
		let test = tests[parts[0]];
		if (!test) {
			return;
		}

		for (const part of parts.slice(1)) {
			test = this.resolver.getOrCreateSubTest(test, part, true);
		}
		return test;
	}

	// Process benchmark events (see test_events.md)
	consumeGoBenchmarkEvent(
		run: TestRun,
		benchmarks: Record<string, TestItem>,
		complete: Set<TestItem>,
		e: GoTestOutput
	) {
		if (e.Test) {
			// Find (or create) the (sub)benchmark
			const test = this.resolveTestName(benchmarks, e.Test);
			if (!test) {
				return;
			}

			switch (e.Action) {
				case 'fail': // Failed
					run.failed(test, { message: 'Failed' });
					complete.add(test);
					break;

				case 'skip': // Skipped
					run.skipped(test);
					complete.add(test);
					break;
			}

			return;
		}

		// Ignore anything that's not an output event
		if (!e.Output) {
			return;
		}

		// On start:    "BenchmarkFooBar"
		// On complete: "BenchmarkFooBar-4    123456    123.4 ns/op    123 B/op    12 allocs/op"

		// Extract the benchmark name and status
		const m = e.Output.match(/^(?<name>Benchmark[/\w]+)(?:-(?<procs>\d+)\s+(?<result>.*))?(?:$|\n)/);
		if (!m) {
			// If the output doesn't start with `BenchmarkFooBar`, ignore it
			return;
		}

		// Find (or create) the (sub)benchmark
		const test = this.resolveTestName(benchmarks, m.groups.name);
		if (!test) {
			return;
		}

		// If output includes benchmark results, the benchmark passed. If output
		// only includes the benchmark name, the benchmark is running.
		if (m.groups.result) {
			run.passed(test);
			complete.add(test);
			vscode.commands.executeCommand('testing.showMostRecentOutput');
		} else {
			run.started(test);
		}
	}

	// Pass any incomplete benchmarks (see test_events.md)
	markComplete(items: Record<string, TestItem>, complete: Set<TestItem>, fn: (item: TestItem) => void) {
		function mark(item: TestItem) {
			if (!complete.has(item)) {
				fn(item);
			}
			item.children.forEach((child) => mark(child));
		}

		for (const name in items) {
			mark(items[name]);
		}
	}

	// Process test events (see test_events.md)
	consumeGoTestEvent(
		run: TestRun,
		tests: Record<string, TestItem>,
		record: Map<TestItem, string[]>,
		complete: Set<TestItem>,
		concat: boolean,
		e: GoTestOutput
	) {
		const test = this.resolveTestName(tests, e.Test);
		if (!test) {
			return;
		}

		switch (e.Action) {
			case 'cont':
			case 'pause':
				// ignore
				break;

			case 'run':
				run.started(test);
				break;

			case 'pass':
				// TODO(firelizzard18): add messages on pass, once that capability
				// is added.
				complete.add(test);
				run.passed(test, e.Elapsed * 1000);
				break;

			case 'fail': {
				complete.add(test);
				const messages = this.parseOutput(test, record.get(test) || []);

				if (!concat) {
					run.failed(test, messages, e.Elapsed * 1000);
					break;
				}

				const merged = new Map<string, TestMessage>();
				for (const { message, location } of messages) {
					const loc = `${location.uri}:${location.range.start.line}`;
					if (merged.has(loc)) {
						merged.get(loc).message += '\n' + message;
					} else {
						merged.set(loc, { message, location });
					}
				}

				run.failed(test, Array.from(merged.values()), e.Elapsed * 1000);
				break;
			}

			case 'skip':
				complete.add(test);
				run.skipped(test);
				break;

			case 'output':
				if (/^(=== RUN|\s*--- (FAIL|PASS): )/.test(e.Output)) {
					break;
				}

				if (record.has(test)) record.get(test).push(e.Output);
				else record.set(test, [e.Output]);
				break;
		}
	}

	parseOutput(test: TestItem, output: string[]): TestMessage[] {
		const messages: TestMessage[] = [];

		const { kind } = GoTest.parseId(test.id);
		const gotI = output.indexOf('got:\n');
		const wantI = output.indexOf('want:\n');
		if (kind === 'example' && gotI >= 0 && wantI >= 0) {
			const got = output.slice(gotI + 1, wantI).join('');
			const want = output.slice(wantI + 1).join('');
			const message = TestMessage.diff('Output does not match', want, got);
			message.location = new Location(test.uri, test.range.start);
			messages.push(message);
			output = output.slice(0, gotI);
		}

		let current: Location;
		const dir = Uri.joinPath(test.uri, '..');
		for (const line of output) {
			const m = line.match(/^\s*(?<file>.*\.go):(?<line>\d+): ?(?<message>.*\n)$/);
			if (m) {
				const file = Uri.joinPath(dir, m.groups.file);
				const ln = Number(m.groups.line) - 1; // VSCode uses 0-based line numbering (internally)
				current = new Location(file, new Position(ln, 0));
				messages.push({ message: m.groups.message, location: current });
			} else if (current) {
				messages.push({ message: line, location: current });
			}
		}

		return messages;
	}

	isBuildFailure(output: string[]): boolean {
		const rePkg = /^# (?<pkg>[\w/.-]+)(?: \[(?<test>[\w/.-]+).test\])?/;

		// TODO(firelizzard18): Add more sophisticated check for build failures?
		return output.some((x) => rePkg.test(x));
	}
}