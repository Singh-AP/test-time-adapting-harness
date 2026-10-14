import { type IncomingMessage, request } from "node:http";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }>;
	isError?: boolean;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Minimal MCP client for the HTTP+SSE transport (protocol 2024-11-05), which Terminal-Bench tasks use for
 * sidecar servers. It speaks plain node:http so the original Host header can be kept when the URL host is
 * rewritten to a container IP the runner host can reach.
 */
export class McpSseClient {
	private readonly url: URL;
	private readonly hostHeader?: string;
	private readonly requestTimeoutMs: number;
	private stream?: IncomingMessage;
	private postUrl?: URL;
	private connecting?: Promise<void>;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;

	constructor(url: string, o: { hostHeader?: string; requestTimeoutMs?: number } = {}) {
		this.url = new URL(url);
		this.hostHeader = o.hostHeader;
		this.requestTimeoutMs = o.requestTimeoutMs ?? 300_000;
	}

	async listTools(): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = (await this.call("tools/list", cursor ? { cursor } : {})) as {
				tools?: McpToolInfo[];
				nextCursor?: string;
			};
			tools.push(...(page.tools ?? []));
			cursor = page.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		return (await this.call("tools/call", { name, arguments: args })) as McpCallResult;
	}

	close(): void {
		this.stream?.destroy();
		this.stream = undefined;
		this.postUrl = undefined;
		this.connecting = undefined;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("MCP connection closed"));
		}
		this.pending.clear();
	}

	private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
		await this.ensureConnected();
		return this.send(method, params);
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return this.hostHeader ? { host: this.hostHeader, ...extra } : extra;
	}

	private ensureConnected(): Promise<void> {
		if (!this.connecting) {
			this.connecting = this.connect().catch((error) => {
				this.connecting = undefined;
				throw error;
			});
		}
		return this.connecting;
	}

	private async connect(): Promise<void> {
		const endpoint = await new Promise<URL>((resolve, reject) => {
			const req = request(
				this.url,
				{ method: "GET", headers: this.headers({ accept: "text/event-stream" }) },
				(res) => {
					if (res.statusCode !== 200) {
						reject(new Error(`MCP SSE connect failed: HTTP ${res.statusCode}`));
						res.resume();
						return;
					}
					this.stream = res;
					let buffer = "";
					let resolved = false;
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						buffer += chunk.replace(/\r\n/g, "\n");
						let split = buffer.indexOf("\n\n");
						while (split >= 0) {
							const block = buffer.slice(0, split);
							buffer = buffer.slice(split + 2);
							const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? "message";
							const data = block
								.split("\n")
								.filter((l) => l.startsWith("data:"))
								.map((l) => l.slice(5).replace(/^ /, ""))
								.join("\n");
							if (event === "endpoint" && !resolved) {
								resolved = true;
								resolve(new URL(data.trim(), this.url));
							} else if (event === "message" && data) this.onMessage(data);
							split = buffer.indexOf("\n\n");
						}
					});
					res.on("end", () => this.close());
					res.on("error", () => this.close());
				},
			);
			req.on("error", reject);
			req.setTimeout(30_000, () => req.destroy(new Error("MCP SSE connect timed out")));
			req.end();
		});
		this.postUrl = endpoint;
		await this.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "tta-pi-harness", version: "0.1.0" },
		});
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	private onMessage(data: string): void {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string };
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (message.method === "ping" && message.id !== undefined) {
			void this.post({ jsonrpc: "2.0", id: message.id, result: {} }).catch(() => {});
			return;
		}
		const pending = message.id === undefined ? undefined : this.pending.get(message.id);
		if (!pending || message.id === undefined) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error)
			pending.reject(new Error(`MCP error: ${message.error.message ?? JSON.stringify(message.error)}`));
		else pending.resolve(message.result);
	}

	private send(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP ${method} timed out after ${this.requestTimeoutMs} ms`));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.post({ jsonrpc: "2.0", id, method, params }).catch((error) => {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		});
		return result;
	}

	private post(message: Record<string, unknown>): Promise<void> {
		const target = this.postUrl;
		if (!target) return Promise.reject(new Error("MCP endpoint unknown"));
		const body = JSON.stringify(message);
		return new Promise((resolve, reject) => {
			const req = request(
				target,
				{
					method: "POST",
					headers: this.headers({
						"content-type": "application/json",
						"content-length": String(Buffer.byteLength(body)),
					}),
				},
				(res) => {
					res.resume();
					if ((res.statusCode ?? 500) >= 300) reject(new Error(`MCP POST failed: HTTP ${res.statusCode}`));
					else resolve();
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	}
}

/** `mcp__<server>__<tool>`, restricted to the characters and length tool names allow. */
export function mcpToolName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** pi tool definitions for every tool of an MCP server. */
export async function mcpToolDefinitions(
	server: string,
	client: McpSseClient,
): Promise<ToolDefinition<any, any, any>[]> {
	const tools = await client.listTools();
	return tools.map((tool) =>
		defineTool({
			name: mcpToolName(server, tool.name),
			label: `${server}/${tool.name}`,
			description: `${tool.description ?? tool.name} (MCP server ${server})`,
			parameters: {
				...(tool.inputSchema ?? {}),
				type: (tool.inputSchema?.type as string) ?? "object",
				properties: (tool.inputSchema?.properties as Record<string, unknown>) ?? {},
			} as never,
			execute: async (_id, params) => {
				const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
				const content = (result.content ?? []).map((c) =>
					c.type === "image" && c.data
						? { type: "image" as const, data: String(c.data), mimeType: String(c.mimeType ?? "image/png") }
						: { type: "text" as const, text: c.type === "text" ? String(c.text ?? "") : JSON.stringify(c) },
				);
				return {
					content: content.length ? content : [{ type: "text", text: "(no content)" }],
					details: undefined,
					isError: Boolean(result.isError),
				};
			},
		}),
	);
}
