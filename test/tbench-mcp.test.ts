import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { McpSseClient, mcpToolDefinitions, mcpToolName } from "../src/tbench/mcp.ts";

/** A minimal MCP server on the legacy HTTP+SSE transport with one tool, `shout`. */
async function fakeSseServer() {
	const streams = new Map<string, ServerResponse>();
	const hosts: string[] = [];
	const server = createServer((req, res) => {
		hosts.push(String(req.headers.host));
		const url = new URL(req.url ?? "/", "http://x");
		if (req.method === "GET" && url.pathname === "/sse") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const id = `s${streams.size + 1}`;
			streams.set(id, res);
			res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
			return;
		}
		if (req.method === "POST" && url.pathname === "/messages") {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				res.writeHead(202).end("Accepted");
				const message = JSON.parse(body);
				const stream = streams.get(String(url.searchParams.get("sessionId")));
				if (message.id === undefined || !stream) return;
				let result: unknown = {};
				if (message.method === "initialize")
					result = {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1" },
					};
				if (message.method === "tools/list")
					result = {
						tools: [
							{
								name: "shout",
								description: "Upper-cases text.",
								inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
							},
						],
					};
				if (message.method === "tools/call")
					result = { content: [{ type: "text", text: String(message.params.arguments.text).toUpperCase() }] };
				stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
			});
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		hosts,
		close: () => {
			for (const s of streams.values()) s.end();
			server.close();
		},
	};
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("McpSseClient", () => {
	test("connects, lists tools and calls them, keeping the original Host header", async () => {
		const server = await fakeSseServer();
		cleanup = server.close;
		const client = new McpSseClient(`http://127.0.0.1:${server.port}/sse`, { hostHeader: "browser-mcp:3080" });
		const tools = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(["shout"]);
		const result = await client.callTool("shout", { text: "hello" });
		expect(result.content).toEqual([{ type: "text", text: "HELLO" }]);
		expect(server.hosts.every((h) => h === "browser-mcp:3080")).toBe(true);
		client.close();
	});

	test("tool definitions call through to the server", async () => {
		const server = await fakeSseServer();
		cleanup = server.close;
		const client = new McpSseClient(`http://127.0.0.1:${server.port}/sse`);
		const [tool] = await mcpToolDefinitions("browser", client);
		expect(tool.name).toBe("mcp__browser__shout");
		const result = await tool.execute("c1", { text: "abc" }, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: "ABC" }]);
		client.close();
	});
});

describe("mcpToolName", () => {
	test("is a valid Bedrock tool name of at most 64 characters", () => {
		const name = mcpToolName("my server", `tool.with/odd chars${"x".repeat(80)}`);
		expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(name.startsWith("mcp__my_server__tool_with_odd_chars")).toBe(true);
	});
});
