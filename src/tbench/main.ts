/**
 * Entry point spawned by python/tbench/harbor_agent.py for one Terminal-Bench trial.
 * Usage: node src/tbench/main.ts <config.json>
 * stdout carries only bridge messages; logs go to stderr.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../util/text.ts";
import { runTerminalAgent } from "./agent.ts";
import { HarborBridge } from "./bridge.ts";
import { loadHarness } from "./harness.ts";
import { bridgeEnvironment } from "./remote.ts";

interface AgentConfig {
	instruction: string;
	modelId: string;
	harnessDir: string;
	timeBudgetSec: number;
	logsDir: string;
	thinkingLevel?: ThinkingLevel | "off";
}

async function main(): Promise<void> {
	console.log = console.error;
	console.info = console.error;
	const config = JSON.parse(await readFile(process.argv[2], "utf8")) as AgentConfig;
	const bridge = new HarborBridge(process.stdin, process.stdout);
	const runtime = await ModelRuntime.create({
		authPath: join(config.logsDir, ".pi", "auth.json"),
		modelsPath: join(config.logsDir, ".pi", "models.json"),
		refreshOnCreate: false,
	});
	const model = runtime.getModel("amazon-bedrock", config.modelId);
	if (!model) throw new Error(`Unknown amazon-bedrock model "${config.modelId}"`);
	const harness = await loadHarness(config.harnessDir);
	if (config.thinkingLevel) harness.thinkingLevel = config.thinkingLevel;
	const result = await runTerminalAgent({
		instruction: config.instruction,
		env: bridgeEnvironment(bridge),
		runtime,
		model,
		harness,
		timeBudgetSec: config.timeBudgetSec,
		logsDir: config.logsDir,
		onUsage: (usage) => bridge.emit("usage", { ...usage }),
	});
	bridge.emit("done", { ...result });
	await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
	process.exit(0);
}

main().catch((error) => {
	console.error(`tbench agent failed: ${errorMessage(error)}`);
	process.exit(1);
});
