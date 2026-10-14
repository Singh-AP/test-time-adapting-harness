import { type RemoteEnvironment, RemoteShell, remoteFileOperations } from "./remote.ts";

export interface SelfTestCheck {
	name: string;
	ok: boolean;
	detail: string;
}

/**
 * Exercises the tool layer inside a real task container without any model calls: output streams, exit codes,
 * timeouts, background jobs, truncation and file transfer. Run it on a host before spending on a benchmark.
 */
export async function runSelfTest(env: RemoteEnvironment, cwd: string): Promise<SelfTestCheck[]> {
	const shell = new RemoteShell(env, { cwd, headBytes: 2000, tailBytes: 2000 });
	const checks: SelfTestCheck[] = [];
	const check = async (name: string, f: () => Promise<[boolean, string]>) => {
		try {
			const [ok, detail] = await f();
			checks.push({ name, ok, detail });
		} catch (error) {
			checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
		}
	};
	await check("stdout and stderr, exit 0", async () => {
		const r = await shell.run("echo out; echo err >&2", 30);
		const ok = r.exitCode === 0 && !r.timedOut && r.output.includes("out") && r.output.includes("err");
		return [ok && !r.output.includes("__TTA_STATUS__"), JSON.stringify(r)];
	});
	await check("non-zero exit code", async () => {
		const r = await shell.run("exit 3", 30);
		return [r.exitCode === 3 && !r.timedOut, JSON.stringify(r)];
	});
	await check("timeout kills the command", async () => {
		const r = await shell.run("sleep 20; echo late", 2);
		return [r.timedOut && !r.output.includes("late"), JSON.stringify(r)];
	});
	await check("background job does not block", async () => {
		const started = Date.now();
		const r = await shell.run("nohup sleep 60 > /tmp/tta-selftest-bg.log 2>&1 & echo started", 30);
		const seconds = (Date.now() - started) / 1000;
		return [
			r.exitCode === 0 && r.output.includes("started") && seconds < 20,
			`${seconds.toFixed(1)}s ${JSON.stringify(r)}`,
		];
	});
	await check("long output keeps head and tail", async () => {
		const r = await shell.run("seq 1 100000", 60);
		const ok = r.output.startsWith("1\n") && r.output.includes("100000") && r.output.includes("bytes omitted");
		return [ok, `${r.output.length} chars`];
	});
	await check("working directory", async () => {
		const r = await shell.run("pwd", 30);
		return [r.output.trim() === cwd, r.output.trim()];
	});
	await check("upload and download round trip", async () => {
		const files = remoteFileOperations(env);
		const path = "/tmp/tta-selftest/dir/file.txt";
		await files.write.mkdir("/tmp/tta-selftest/dir");
		await files.write.writeFile(path, "héllo\nworld\n");
		await files.read.access(path);
		const back = (await files.read.readFile(path)).toString("utf8");
		return [back === "héllo\nworld\n", JSON.stringify(back)];
	});
	return checks;
}
