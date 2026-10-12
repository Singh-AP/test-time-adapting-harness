import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	isExpiredCredentials,
	isRetryable,
	PiProposerClient,
	PiSolverClient,
	stripThinking,
	usageOf,
} from "../src/llm/pi-clients.ts";

type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function setup(steps: Steps) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(steps);
	return { faux, models, model: faux.getModel() };
}

const fast = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe("PiSolverClient", () => {
	test("sends the system prompt and multi-turn messages and strips thinking tags", async () => {
		let seen = "";
		const { models, model } = setup([
			(context) => {
				seen = JSON.stringify(context);
				return fauxAssistantMessage("<think>hmm</think>Answer: 4");
			},
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		const response = await client.complete({
			system: "sys",
			messages: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "second" },
				{ role: "user", content: "third" },
			],
			maxTokens: 100,
		});
		expect(response.text).toBe("Answer: 4");
		expect(response.stopReason).toBe("stop");
		for (const part of ["sys", "first", "second", "third"]) expect(seen).toContain(part);
	});

	test("retries throttling then succeeds", async () => {
		const { models, model, faux } = setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ThrottlingException: Too many requests" }),
			fauxAssistantMessage("ok"),
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		const response = await client.complete({ messages: [{ role: "user", content: "x" }], maxTokens: 10 });
		expect(response.text).toBe("ok");
		expect(faux.state.callCount).toBe(2);
	});

	test("waits for refreshed credentials after an expired token", async () => {
		const { models, model, faux } = setup([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "ExpiredTokenException: The security token included in the request is expired",
			}),
			fauxAssistantMessage("ok"),
		]);
		let refreshes = 0;
		const client = new PiSolverClient({
			models,
			model,
			retry: { ...fast, expiredPollMs: 1, expiredMaxWaitMs: 1000 },
			refreshCredentials: async () => {
				refreshes++;
			},
		});
		const response = await client.complete({ messages: [{ role: "user", content: "x" }], maxTokens: 10 });
		expect(response.text).toBe("ok");
		expect(refreshes).toBe(1);
		expect(faux.state.callCount).toBe(2);
	});

	test("does not retry validation errors", async () => {
		const { models, model, faux } = setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ValidationException: bad input" }),
			fauxAssistantMessage("never"),
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		await expect(client.complete({ messages: [{ role: "user", content: "x" }], maxTokens: 10 })).rejects.toThrow(
			"ValidationException",
		);
		expect(faux.state.callCount).toBe(1);
	});
});

describe("usage accounting", () => {
	test("counts cached prompt tokens as input", () => {
		const message = fauxAssistantMessage("ok");
		message.usage = { ...message.usage, input: 4, cacheRead: 100, cacheWrite: 2000, output: 7 };
		expect(usageOf(message)).toMatchObject({ input: 2104, output: 7 });
	});
});

describe("PiProposerClient", () => {
	test("returns final text without thinking and reports errors", async () => {
		const { models, model } = setup([
			fauxAssistantMessage([fauxThinking("plan"), fauxText("NO_CHANGE: fine")]),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ValidationException: nope" }),
		]);
		const client = new PiProposerClient({ models, model, retry: fast });
		const ok = await client.complete({ system: "s", messages: [{ role: "user", content: "u" }] });
		expect(ok.text).toBe("NO_CHANGE: fine");
		const bad = await client.complete({ system: "s", messages: [{ role: "user", content: "u" }] });
		expect(bad.stopReason).toBe("error");
		expect(bad.error).toContain("ValidationException");
	});
});

describe("helpers", () => {
	test("isRetryable and stripThinking", () => {
		expect(isRetryable("ThrottlingException: Rate exceeded")).toBe(true);
		expect(isRetryable("ServiceUnavailableException: try later")).toBe(true);
		expect(isRetryable("ValidationException: The model returned the following errors")).toBe(false);
		expect(isExpiredCredentials("ExpiredTokenException: The security token included in the request is expired")).toBe(
			true,
		);
		expect(isExpiredCredentials("ThrottlingException")).toBe(false);
		expect(stripThinking("<think>a</think>\nB")).toBe("B");
		expect(stripThinking("reasoning</think>C")).toBe("C");
		expect(stripThinking("plain")).toBe("plain");
	});
});
