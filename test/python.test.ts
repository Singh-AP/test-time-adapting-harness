import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, test } from "vitest";
import { defaultPythonPath, repoPath } from "../src/config.ts";
import { createPythonRunner } from "../src/tools/python.ts";

const runner = createPythonRunner({ pythonPath: defaultPythonPath() });
const run = (code: string, timeoutMs = 10_000, stdin?: string) => runner.run(code, { timeoutMs, stdin });

describe("guarded python", () => {
	test("runs code with stdin", async () => {
		const result = await run("import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))", 10_000, "1 2 3");
		expect(result).toMatchObject({ stdout: "6\n", exitCode: 0, timedOut: false });
	});

	test("reports exceptions", async () => {
		const result = await run("raise ValueError('bad')");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("ValueError: bad");
	});

	test("times out", async () => {
		const result = await run("while True: pass", 1000);
		expect(result.timedOut).toBe(true);
	});

	test("blocks network access", async () => {
		const result = await run("import socket\nsocket.create_connection(('1.1.1.1', 80), timeout=2)");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("blocked");
	});

	test("blocks subprocesses", async () => {
		expect((await run("import subprocess\nsubprocess.run(['echo', 'hi'])")).stderr).toContain("blocked");
		expect((await run("import os\nos.system('echo hi')")).stderr).toContain("blocked");
	});

	test("blocks reads and writes outside the scratch directory", async () => {
		// HOME is scrubbed to the scratch directory, so use the real home path.
		const home = JSON.stringify(homedir());
		expect(
			(await run(`import os\nprint(open(os.path.join(${home}, ".aws", "credentials")).read())`)).stderr,
		).toContain("blocked");
		expect((await run("open('/tmp/tta-guard-test.txt', 'w').write('x')")).stderr).toContain("blocked");
		expect((await run(`import os\nprint(os.listdir(${home}))`)).stderr).toContain("blocked");
		const local = await run("open('ok.txt', 'w').write('x')\nprint(open('ok.txt').read())");
		expect(local.stdout).toBe("x\n");
	});

	test("blocks native library loading through ctypes", async () => {
		const result = await run("import ctypes\nctypes.CDLL(None)");
		expect(result.stderr).toContain("blocked by sandbox: ctypes.dlopen");
	});

	test("scrubs the environment", async () => {
		process.env.AWS_TTA_TEST_ONLY = "should-not-leak";
		const result = await run("import os\nprint(sorted(k for k in os.environ if 'AWS' in k))");
		delete process.env.AWS_TTA_TEST_ONLY;
		expect(result.stdout).toBe("[]\n");
	});

	test.skipIf(!existsSync(repoPath(".venv", "bin", "python")))("imports numpy and sympy", async () => {
		const result = await run("import numpy, sympy\nprint(int(numpy.sum([1, 2])), sympy.factorint(12))");
		expect(result.stdout).toBe("3 {2: 2, 3: 1}\n");
	});
});
