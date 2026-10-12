import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../config.ts";
import type { PythonResult, PythonRunner } from "../core/types.ts";
import { Semaphore } from "../util/concurrency.ts";

export interface PythonRunnerOptions {
	pythonPath: string;
	maxOutputChars?: number;
	maxConcurrent?: number;
}

/** Runs solver-written Python through python/guard.py with a scrubbed environment and a temp working directory. */
export function createPythonRunner(o: PythonRunnerOptions): PythonRunner {
	const guard = repoPath("python", "guard.py");
	const limiter = new Semaphore(o.maxConcurrent ?? 8);
	const maxChars = o.maxOutputChars ?? 20_000;
	return {
		run: (code, options) =>
			limiter.run(async () => {
				const scratch = await mkdtemp(join(tmpdir(), "tta-py-"));
				try {
					const codePath = join(scratch, "solver.py");
					await writeFile(codePath, code);
					const cpuSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
					return await runProcess(
						o.pythonPath,
						["-I", "-B", "-X", "utf8", guard, scratch, codePath, String(cpuSeconds)],
						{
							cwd: scratch,
							env: scrubbedEnv(scratch),
							stdin: options.stdin,
							timeoutMs: options.timeoutMs,
							signal: options.signal,
							maxChars,
						},
					);
				} finally {
					await rm(scratch, { recursive: true, force: true });
				}
			}),
	};
}

/** Only these variables reach the child: no credentials or provider configuration. */
function scrubbedEnv(scratch: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		HOME: scratch,
		TMPDIR: scratch,
		OPENBLAS_NUM_THREADS: "1",
		OMP_NUM_THREADS: "1",
		MKL_NUM_THREADS: "1",
	};
}

export function runProcess(
	command: string,
	args: string[],
	o: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		stdin?: string;
		timeoutMs: number;
		signal?: AbortSignal;
		maxChars: number;
	},
): Promise<PythonResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
		const out = { stdout: "", stderr: "" };
		let timedOut = false;
		let settled = false;
		const append = (key: "stdout" | "stderr", chunk: Buffer) => {
			if (out[key].length >= o.maxChars) return;
			out[key] += chunk.toString("utf8");
			if (out[key].length >= o.maxChars) out[key] = `${out[key].slice(0, o.maxChars)}\n[output truncated]`;
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		const kill = () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, o.timeoutMs + 250);
		o.signal?.addEventListener("abort", kill, { once: true });
		const done = () => {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", kill);
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			done();
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			done();
			if (signal === "SIGXCPU") timedOut = true;
			resolve({ stdout: out.stdout, stderr: out.stderr, exitCode: code, timedOut });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(o.stdin ?? "");
	});
}
