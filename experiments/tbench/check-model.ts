/**
 * Smoke-checks Bedrock access for a model from a runner host: one short completion through pi-ai.
 * Usage: node experiments/tbench/check-model.ts <model-id> [thinking-level]
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { createBedrockModels, requireModel } from "../../src/llm/pi-clients.ts";

const [modelId = "global.anthropic.claude-sonnet-5-5", reasoning] = process.argv.slice(2);
const models = createBedrockModels();
const model = requireModel(models, modelId);
const started = Date.now();
const reply = await models.completeSimple(
	model,
	{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] },
	{ maxTokens: 2048, reasoning: reasoning as ThinkingLevel | undefined },
);
const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("");
console.log(`${modelId}: ${reply.stopReason} "${text.trim()}" in ${Date.now() - started} ms, cost $${reply.usage.cost.total.toFixed(5)}`);
if (reply.stopReason === "error") process.exit(1);
