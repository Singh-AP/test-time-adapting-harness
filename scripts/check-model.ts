/**
 * Checks that a model is reachable with the current credentials: one short completion through pi-ai.
 * Usage: node scripts/check-model.ts <provider/model> [thinking-level]   (a bare id is an Amazon Bedrock model)
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { createModelCatalog, requireModel } from "../src/llm/pi-clients.ts";

const [modelId = "global.anthropic.claude-sonnet-5-5", reasoning] = process.argv.slice(2);
const models = createModelCatalog();
const model = requireModel(models, modelId);
const started = Date.now();
const reply = await models.completeSimple(
	model,
	{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] },
	{ maxTokens: 2048, reasoning: reasoning as ThinkingLevel | undefined },
);
const text = reply.content.map((c) => (c.type === "text" ? c.text : "")).join("");
console.log(
	`${modelId}: ${reply.stopReason} "${text.trim()}" in ${Date.now() - started} ms, cost $${reply.usage.cost.total.toFixed(5)}`,
);
if (reply.stopReason === "error") {
	console.error(reply.errorMessage ?? "the provider returned an error");
	process.exitCode = 1;
}
if (reply.stopReason === "error") process.exit(1);
