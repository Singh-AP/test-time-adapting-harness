import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { type RemoteEnvironment, RemoteShell, remoteFileOperations } from "../src/tbench/remote.ts";

const run = promisify(execFile);

/** Runs commands with the local bash, like `docker exec <container> bash -c`, and keeps files in a temp root. */
async function localEnvironment() {
	const root = await mkdtemp(join(tmpdir(), "tta-remote-"));
	const commands: string[] = [];
	const uploads: string[] = [];
	const env: RemoteEnvironment = {
		exec: async (command) => {
			commands.push(command);
			try {
				const { stdout, stderr } = await run("bash", ["-c", command], { maxBuffer: 64 * 1024 * 1024 });
				return { stdout, stderr, returnCode: 0 };
			} catch (error) {
				const e = error as { stdout?: string; stderr?: string; code?: number };
				return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", returnCode: Number(e.code ?? 1) };
			}
		},
		upload: async (path, content) => {
			uploads.push(path);
			await run("mkdir", ["-p", dirname(path)]);
			await writeFile(path, content);
		},
		download: async (path) => readFile(path),
	};
	return { env, root, commands, uploads };
}

/** Like Harbor's Docker environment: stderr is merged into stdout (docker compose exec, stderr=STDOUT). */
async function mergedEnvironment() {
	const local = await localEnvironment();
	const env: RemoteEnvironment = {
		...local.env,
		exec: async (command, timeoutSec) => {
			const r = await local.env.exec(command, timeoutSec);
			return { stdout: `${r.stderr}${r.stdout}`, stderr: "", returnCode: r.returnCode };
		},
	};
	return { ...local, env };
}

describe("RemoteShell with merged output streams", () => {
	test("parses the status and hides the status line when stderr is merged into stdout", async () => {
		const { env, root } = await mergedEnvironment();
		const shell = new RemoteShell(env, { cwd: root, stateDir: join(root, ".tta") });
		const ok = await shell.run("echo out; echo err >&2", 30);
		expect(ok.exitCode).toBe(0);
		expect(ok.timedOut).toBe(false);
		expect(ok.output).toContain("out");
		expect(ok.output).toContain("err");
		expect(ok.output).not.toContain("__TTA_STATUS__");
		const failed = await shell.run("echo bad; exit 7", 30);
		expect(failed.exitCode).toBe(7);
		expect(failed.timedOut).toBe(false);
		expect(failed.output).not.toContain("__TTA_STATUS__");
	});
});

describe("RemoteShell", () => {
	test("runs a command in the working directory and reports output and exit code", async () => {
		const { env, root } = await localEnvironment();
		const shell = new RemoteShell(env, { cwd: root, stateDir: join(root, ".tta") });
		const ok = await shell.run(`echo "hello 'world'" && pwd && echo err >&2`, 30);
		expect(ok.exitCode).toBe(0);
		expect(ok.timedOut).toBe(false);
		expect(ok.output).toContain("hello 'world'");
		expect(ok.output).toContain(root);
		expect(ok.output).toContain("err");
		const failed = await shell.run("exit 3", 30);
		expect(failed.exitCode).toBe(3);
	});

	test("keeps the head and tail of long output and points to the full log", async () => {
		const { env, root } = await localEnvironment();
		const shell = new RemoteShell(env, { cwd: root, stateDir: join(root, ".tta"), headBytes: 100, tailBytes: 100 });
		const result = await shell.run("for i in $(seq 1 2000); do echo line-$i; done", 30);
		expect(result.output).toContain("line-1\n");
		expect(result.output).toContain("line-2000");
		expect(result.output).not.toContain("line-1000\n");
		expect(result.output).toMatch(/bytes omitted; full output in .*\.log/);
		const full = await readFile(result.logPath, "utf8");
		expect(full).toContain("line-1000\n");
	});

	test("does not hang on commands that read stdin", async () => {
		const { env, root } = await localEnvironment();
		const shell = new RemoteShell(env, { cwd: root, stateDir: join(root, ".tta") });
		const result = await shell.run("read answer; echo got:$answer", 30);
		expect(result.output).toContain("got:");
	});

	test("uploads long commands as a script instead of inlining them", async () => {
		const { env, root, uploads } = await localEnvironment();
		const shell = new RemoteShell(env, { cwd: root, stateDir: join(root, ".tta"), inlineLimit: 50 });
		const result = await shell.run(`cat <<'EOF'\n${"x".repeat(200)}\nEOF`, 30);
		expect(result.output).toContain("x".repeat(200));
		expect(uploads.length).toBe(1);
	});
});

describe("remote file operations", () => {
	test("pi read and write tools work through the remote environment", async () => {
		const { env, root } = await localEnvironment();
		const ops = remoteFileOperations(env);
		const write = createWriteToolDefinition(root, { operations: ops.write });
		await write.execute(
			"w1",
			{ path: "sub/notes.txt", content: "alpha\nbeta\n" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(await readFile(join(root, "sub/notes.txt"), "utf8")).toBe("alpha\nbeta\n");
		const read = createReadToolDefinition(root, { operations: ops.read });
		const result = await read.execute("r1", { path: "sub/notes.txt" }, undefined, undefined, undefined as never);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
	});

	test("access fails for missing files", async () => {
		const { env, root } = await localEnvironment();
		await expect(remoteFileOperations(env).read.access(join(root, "missing.txt"))).rejects.toThrow();
	});
});

describe("runSelfTest", () => {
	test("all checks pass on a Harbor-like environment with merged streams", async () => {
		const { runSelfTest } = await import("../src/tbench/selftest.ts");
		const { env, root } = await mergedEnvironment();
		const checks = await runSelfTest(env, root);
		expect(checks.filter((c) => !c.ok)).toEqual([]);
		expect(checks.length).toBe(7);
	}, 60_000);
});
