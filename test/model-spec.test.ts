import { describe, expect, test } from "vitest";
import { parseModelSpec } from "../src/llm/model-spec.ts";
import { createModelCatalog, requireModel } from "../src/llm/pi-clients.ts";

const PROVIDERS = ["amazon-bedrock", "anthropic", "openai", "openrouter"];

describe("parseModelSpec", () => {
	test("a known provider prefix selects that provider", () => {
		expect(parseModelSpec("anthropic/claude-sonnet-5-5", PROVIDERS)).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-5-5",
		});
		expect(parseModelSpec("amazon-bedrock/global.anthropic.claude-sonnet-5-5", PROVIDERS)).toEqual({
			provider: "amazon-bedrock",
			id: "global.anthropic.claude-sonnet-5-5",
		});
	});

	test("only the first slash separates the provider, so router model ids keep theirs", () => {
		expect(parseModelSpec("openrouter/anthropic/claude-sonnet-5.5", PROVIDERS)).toEqual({
			provider: "openrouter",
			id: "anthropic/claude-sonnet-5.5",
		});
	});

	test("bare ids and ARNs are Amazon Bedrock models", () => {
		expect(parseModelSpec("us.anthropic.claude-opus-5-5", PROVIDERS)).toEqual({
			provider: "amazon-bedrock",
			id: "us.anthropic.claude-opus-5-5",
		});
		const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5-5";
		expect(parseModelSpec(arn, PROVIDERS)).toEqual({ provider: "amazon-bedrock", id: arn });
	});
});

describe("requireModel", () => {
	test("resolves models of any built-in provider from one catalog", () => {
		const models = createModelCatalog();
		expect(requireModel(models, "anthropic/claude-sonnet-5-5").provider).toBe("anthropic");
		expect(requireModel(models, "openai/gpt-5.5").provider).toBe("openai");
		const bedrock = requireModel(models, "global.anthropic.claude-sonnet-5-5");
		expect([bedrock.provider, bedrock.id]).toEqual(["amazon-bedrock", "global.anthropic.claude-sonnet-5-5"]);
	});

	test("an unknown model names the provider it looked in and the expected form", () => {
		expect(() => requireModel(createModelCatalog(), "anthropic/no-such-model")).toThrow(
			/anthropic.*no-such-model[\s\S]*provider\/model/,
		);
	});
});
