import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { repoPath } from "../../config.ts";

export interface RgEntry {
	index: number;
	question: string;
	answer: string;
	metadata: Record<string, unknown>;
}

export interface BridgeOptions {
	pythonPath: string;
	scriptPath?: string;
	requestTimeoutMs?: number;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** A persistent python/rg_bridge.py process. Restarts on exit or timeout. */
export class ReasoningGymBridge {
	private readonly options: BridgeOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private stderrTail = "";

	constructor(options: BridgeOptions) {
		this.options = options;
	}

	async generate(
		family: string,
		size: number,
		seed: number,
		config: Record<string, unknown> = {},
	): Promise<{ entries: RgEntry[]; doc: string }> {
		const response = await this.request({ op: "generate", family, size, seed, config });
		return { entries: response.entries as RgEntry[], doc: String(response.doc ?? "") };
	}

	async score(
		family: string,
		size: number,
		seed: number,
		index: number,
		answer: string,
		config: Record<string, unknown> = {},
	): Promise<number> {
		const response = await this.request({ op: "score", family, size, seed, index, answer, config });
		return Number(response.score);
	}

	async families(): Promise<string[]> {
		return (await this.request({ op: "families" })).families as string[];
	}

	request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const child = this.ensureStarted();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`reasoning_gym bridge timed out on ${String(payload.op)}`));
				this.restart();
			}, this.options.requestTimeoutMs ?? 120_000);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;
		const script = this.options.scriptPath ?? repoPath("python", "rg_bridge.py");
		const child = spawn(this.options.pythonPath, ["-I", "-B", "-W", "ignore", script], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
		});
		this.child = child;
		createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
		});
		child.stdin.on("error", () => {});
		child.on("exit", (code) => {
			if (this.child === child) this.child = undefined;
			const error = new Error(
				`reasoning_gym bridge exited with code ${code}: ${this.stderrTail.trim().slice(-800)}`,
			);
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(error);
				this.pending.delete(id);
			}
		});
		return child;
	}

	private onLine(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000);
			return;
		}
		const id = Number(message.id);
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve(message);
		else pending.reject(new Error(`reasoning_gym: ${String(message.error)}`));
	}

	private restart(): void {
		const child = this.child;
		this.child = undefined;
		child?.kill("SIGKILL");
	}
}
