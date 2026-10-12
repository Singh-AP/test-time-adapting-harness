import { describe, expect, test } from "vitest";
import type { AdaptSummary } from "../src/core/loop.ts";
import { createAdaptExtension, formatSummary, parseAdaptArgs } from "../src/pi/extension.ts";
import type { AdaptRequest, AdaptService } from "../src/pi/service.ts";

const SUMMARY: AdaptSummary = {
	task: "toy:addition",
	runDir: "/tmp/run",
	seedHeldout: 0.25,
	finalHeldout: 0.75,
	rounds: [],
	finalHash: "abc",
	usage: {
		solver: { input: 1, output: 1, cost: 0.01, calls: 2 },
		proposer: { input: 1, output: 1, cost: 0.2, calls: 1 },
	},
};

function fakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messages: unknown[] = [];
	return {
		tools,
		commands,
		messages,
		api: {
			registerTool: (tool: any) => tools.set(tool.name, tool),
			registerCommand: (name: string, options: any) => commands.set(name, options),
			sendMessage: (message: unknown) => messages.push(message),
		},
	};
}

describe("pi extension", () => {
	test("parses /adapt arguments", () => {
		expect(parseAdaptArgs("rg:maze --rounds 3 --proposals 2 --protocol qa --solver s --dev 10")).toEqual({
			task: "rg:maze",
			rounds: 3,
			proposals: 2,
			protocol: "qa",
			solver: "s",
			dev: 10,
		});
		expect(() => parseAdaptArgs("")).toThrow("Usage: /adapt");
		expect(() => parseAdaptArgs("rg:maze --rounds x")).toThrow("--rounds");
	});

	test("adapt_harness runs the service and summarizes", async () => {
		const requests: AdaptRequest[] = [];
		const service: AdaptService = {
			run: async (request, log) => {
				requests.push(request);
				log("round 1 done");
				return SUMMARY;
			},
		};
		const pi = fakePi();
		createAdaptExtension(service)(pi.api as never);
		const tool = pi.tools.get("adapt_harness");
		const updates: string[] = [];
		const result = await tool.execute(
			"id",
			{ task: "toy:addition", rounds: 1 },
			undefined,
			(u: any) => updates.push(u.content[0].text),
			{},
		);
		expect(requests[0]).toMatchObject({ task: "toy:addition", rounds: 1 });
		expect(updates).toContain("round 1 done");
		expect(result.content[0].text).toContain("0.250 -> 0.750");
		expect(pi.commands.has("adapt")).toBe(true);
		expect(pi.commands.has("harness-runs")).toBe(true);
	});

	test("formatSummary reports held-out scores, cost and artifacts", () => {
		const text = formatSummary(SUMMARY);
		expect(text).toContain("toy:addition");
		expect(text).toContain("/tmp/run");
		expect(text).toContain("$0.21");
	});
});
