import { createInterface } from "node:readline";

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

/**
 * JSON-lines channel to the Harbor agent process (python/tbench/harbor_agent.py).
 * The agent sends `{kind: "request", id, op, ...}` and `{kind: "event", event, ...}` lines;
 * Harbor answers each request with `{kind: "response", id, ok, result | error}`.
 */
export class HarborBridge {
	private readonly output: NodeJS.WritableStream;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private closedError: Error | undefined;

	constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
		this.output = output;
		const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", (line) => this.onLine(line));
		lines.on("close", () => this.close(new Error("Harbor closed the bridge")));
	}

	request(op: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ kind: "request", id, op, ...payload });
		});
	}

	emit(event: string, payload: Record<string, unknown> = {}): void {
		if (!this.closedError) this.write({ kind: "event", event, ...payload });
	}

	close(error: Error = new Error("bridge closed")): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private write(message: Record<string, unknown>): void {
		this.output.write(`${JSON.stringify(message)}\n`);
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.kind !== "response") return;
		const pending = this.pending.get(Number(message.id));
		if (!pending) return;
		this.pending.delete(Number(message.id));
		if (message.ok) pending.resolve((message.result ?? {}) as Record<string, unknown>);
		else pending.reject(new Error(String(message.error ?? "request failed")));
	}
}
