import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { HarborBridge } from "../src/tbench/bridge.ts";

/** A fake Harbor side: reads the agent's lines from `toHarbor` and answers on `toAgent`. */
function harness() {
	const toHarbor = new PassThrough();
	const toAgent = new PassThrough();
	const sent: Record<string, unknown>[] = [];
	let buffer = "";
	toHarbor.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			sent.push(JSON.parse(buffer.slice(0, index)));
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
	});
	const reply = (message: Record<string, unknown>) => toAgent.write(`${JSON.stringify(message)}\n`);
	const bridge = new HarborBridge(toAgent, toHarbor);
	return { bridge, sent, reply };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("HarborBridge", () => {
	test("matches responses to requests by id, in any order", async () => {
		const { bridge, sent, reply } = harness();
		const first = bridge.request("exec", { command: "echo 1" });
		const second = bridge.request("exec", { command: "echo 2" });
		await tick();
		expect(sent.map((m) => [m.kind, m.op, m.command])).toEqual([
			["request", "exec", "echo 1"],
			["request", "exec", "echo 2"],
		]);
		reply({ kind: "response", id: sent[1].id, ok: true, result: { output: "2" } });
		reply({ kind: "response", id: sent[0].id, ok: true, result: { output: "1" } });
		expect(await first).toEqual({ output: "1" });
		expect(await second).toEqual({ output: "2" });
	});

	test("error responses reject with the error text", async () => {
		const { bridge, sent, reply } = harness();
		const pending = bridge.request("download", { path: "/missing" });
		await tick();
		reply({ kind: "response", id: sent[0].id, ok: false, error: "No such file: /missing" });
		await expect(pending).rejects.toThrow("No such file: /missing");
	});

	test("events are one-way messages", async () => {
		const { bridge, sent } = harness();
		bridge.emit("usage", { input: 10, output: 2 });
		await tick();
		expect(sent).toEqual([{ kind: "event", event: "usage", input: 10, output: 2 }]);
	});

	test("pending requests reject when the Harbor side closes", async () => {
		const { bridge } = harness();
		const pending = bridge.request("exec", { command: "sleep 100" });
		bridge.close(new Error("harbor went away"));
		await expect(pending).rejects.toThrow("harbor went away");
	});
});
