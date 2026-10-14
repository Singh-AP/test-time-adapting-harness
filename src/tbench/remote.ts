import { posix } from "node:path";
import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { HarborBridge } from "./bridge.ts";

export interface RemoteExecResult {
	stdout: string;
	stderr: string;
	returnCode: number;
}

/** The task container, as seen through Harbor's environment API. */
export interface RemoteEnvironment {
	/** Runs `command` with bash in the container; `timeoutSec` bounds the Harbor-side wait. */
	exec(command: string, timeoutSec: number): Promise<RemoteExecResult>;
	upload(path: string, content: Buffer): Promise<void>;
	download(path: string): Promise<Buffer>;
}

export function bridgeEnvironment(bridge: HarborBridge): RemoteEnvironment {
	return {
		exec: async (command, timeoutSec) => {
			const r = await bridge.request("exec", { command, timeout_sec: timeoutSec });
			return {
				stdout: String(r.stdout ?? ""),
				stderr: String(r.stderr ?? ""),
				returnCode: Number(r.return_code ?? 0),
			};
		},
		upload: async (path, content) => {
			await bridge.request("upload", { path, content_b64: content.toString("base64") });
		},
		download: async (path) => {
			const r = await bridge.request("download", { path });
			return Buffer.from(String(r.content_b64 ?? ""), "base64");
		},
	};
}

/** Single-quotes a string for bash. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RemoteShellOptions {
	/** Working directory for every command (each command runs in a fresh shell). */
	cwd: string;
	/** Container directory for command scripts and full output logs. */
	stateDir?: string;
	headBytes?: number;
	tailBytes?: number;
	/** Commands longer than this are uploaded as a script file instead of being inlined. */
	inlineLimit?: number;
	/** Extra seconds Harbor waits beyond the command timeout before giving up. */
	graceSec?: number;
}

export interface ShellResult {
	output: string;
	exitCode: number;
	timedOut: boolean;
	elapsedSec: number;
	logPath: string;
}

const STATUS = "__TTA_STATUS__";

/**
 * Runs agent commands in the container. Each command is written to a script, runs under `timeout` with stdin
 * from /dev/null and output redirected to a log file (so background processes cannot hold Harbor's pipe open),
 * and only the head and tail of the log come back.
 */
export class RemoteShell {
	private readonly env: RemoteEnvironment;
	private readonly o: Required<RemoteShellOptions>;
	private counter = 0;

	constructor(env: RemoteEnvironment, o: RemoteShellOptions) {
		this.env = env;
		this.o = {
			stateDir: "/tmp/.tta",
			headBytes: 12_000,
			tailBytes: 24_000,
			inlineLimit: 48_000,
			graceSec: 60,
			...o,
		};
	}

	async run(command: string, timeoutSec: number): Promise<ShellResult> {
		const n = ++this.counter;
		const stamp = `${Date.now().toString(36)}-${n}`;
		const scriptPath = posix.join(this.o.stateDir, `cmd-${stamp}.sh`);
		const logPath = posix.join(this.o.stateDir, `out-${stamp}.log`);
		const encoded = Buffer.from(command, "utf8").toString("base64");
		const inline = encoded.length <= this.o.inlineLimit;
		if (!inline) await this.env.upload(scriptPath, Buffer.from(command, "utf8"));
		const t = Math.max(1, Math.ceil(timeoutSec));
		const { headBytes: head, tailBytes: tail } = this.o;
		const q = shellQuote;
		const script = [
			"set +e",
			`mkdir -p ${q(this.o.stateDir)}`,
			inline ? `printf '%s' '${encoded}' | base64 -d > ${q(scriptPath)}` : "",
			`cd ${q(this.o.cwd)} 2>/dev/null || cd /`,
			"start=$(date +%s)",
			"if command -v timeout >/dev/null 2>&1; then",
			`  timeout -k 10 ${t} bash ${q(scriptPath)} > ${q(logPath)} 2>&1 < /dev/null`,
			"else",
			`  bash ${q(scriptPath)} > ${q(logPath)} 2>&1 < /dev/null`,
			"fi",
			"code=$?",
			"elapsed=$(( $(date +%s) - start ))",
			`size=$(wc -c < ${q(logPath)} | tr -d ' ')`,
			`if [ "$size" -le ${head + tail} ]; then cat ${q(logPath)}; else`,
			`  head -c ${head} ${q(logPath)}`,
			`  printf '\\n\\n[... %s bytes omitted; full output in %s ...]\\n\\n' "$((size - ${head + tail}))" ${q(logPath)}`,
			`  tail -c ${tail} ${q(logPath)}`,
			"fi",
			"timed=0",
			`if [ "$elapsed" -ge ${t} ] && { [ "$code" = 124 ] || [ "$code" = 137 ]; }; then timed=1; fi`,
			// Harbor's Docker environment merges stderr into stdout, so the status is the last line of stdout.
			`printf '\\n${STATUS} %s %s %s\\n' "$code" "$timed" "$elapsed"`,
		]
			.filter(Boolean)
			.join("\n");
		const r = await this.env.exec(script, t + this.o.graceSec);
		const combined = r.stderr ? `${r.stdout}\n${r.stderr}` : r.stdout;
		const matches = [...combined.matchAll(new RegExp(`\\n?${STATUS} (\\d+) ([01]) (\\d+)\\n?`, "g"))];
		const output = combined.replace(new RegExp(`\\n?${STATUS} \\d+ [01] \\d+\\n?`, "g"), "");
		const status = matches.at(-1);
		if (!status)
			return { output: output.trim(), exitCode: r.returnCode || 1, timedOut: true, elapsedSec: t, logPath };
		return {
			output,
			exitCode: Number(status[1]),
			timedOut: status[2] === "1",
			elapsedSec: Number(status[3]),
			logPath,
		};
	}
}

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** pi read/write/edit operations backed by the container. */
export function remoteFileOperations(env: RemoteEnvironment): {
	read: ReadOperations;
	write: WriteOperations;
	edit: EditOperations;
} {
	const access = async (path: string) => {
		const r = await env.exec(`test -e ${shellQuote(path)} && test -r ${shellQuote(path)}`, 30);
		if (r.returnCode !== 0) throw new Error(`ENOENT: no such file or not readable: ${path}`);
	};
	const readFile = (path: string) => env.download(path);
	const writeFile = (path: string, content: string) => env.upload(path, Buffer.from(content, "utf8"));
	const mkdir = async (dir: string) => {
		const r = await env.exec(`mkdir -p ${shellQuote(dir)}`, 30);
		if (r.returnCode !== 0) throw new Error(`mkdir failed for ${dir}: ${r.stderr || r.stdout}`);
	};
	return {
		read: {
			readFile,
			access,
			detectImageMimeType: async (path) => IMAGE_TYPES[posix.extname(path).toLowerCase()] ?? null,
		},
		write: { writeFile, mkdir },
		edit: { readFile, writeFile, access },
	};
}
