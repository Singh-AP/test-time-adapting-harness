/**
 * Entry point spawned by python/tbench/harbor_agent.py for one Terminal-Bench trial.
 * Usage: node src/tbench/main.ts <config.json>
 * stdout carries only bridge messages; logs go to stderr.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../util/text.ts";
import { type McpServer, runTerminalAgent } from "./agent.ts";
import { HarborBridge } from "./bridge.ts";
import { loadHarness } from "./harness.ts";
import { bridgeEnvironment } from "./remote.ts";
import { runSelfTest } from "./selftest.ts";

interface AgentConfig {
	instruction: string;
	modelId: string;
	harnessDir: string;
	timeBudgetSec: number;
	logsDir: string;
	thinkingLevel?: ThinkingLevel | "off";
	/** Exercise the tool layer in the container without model calls (see selftest.ts). */
	selfTest?: boolean;
	skillsDir?: string;
	mcpServers?: McpServer[];
}

async function main(): Promise<void> {
	console.log = console.error;
	console.info = console.error;
	const config = JSON.parse(await readFile(process.argv[2], "utf8")) as AgentConfig;
	const bridge = new HarborBridge(process.stdin, process.stdout);
	if (config.selfTest) {
		const env = bridgeEnvironment(bridge);
		const cwd = (await env.exec("pwd", 30)).stdout.trim() || "/";
		const checks = await runSelfTest(env, cwd);
		const failed = checks.filter((c) => !c.ok);
		await mkdir(config.logsDir, { recursive: true });
		await writeFile(join(config.logsDir, "selftest.json"), `${JSON.stringify(checks, null, 2)}\n`);
		console.error(failed.length ? `SELF-TEST FAILED: ${failed.map((c) => c.name).join(", ")}` : "SELF-TEST OK");
		bridge.emit("done", { stopReason: failed.length ? "selftest-failed" : "selftest-ok", errors: failed });
		await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
		process.exit(failed.length ? 1 : 0);
	}
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
		skillsDir: config.skillsDir,
		mcpServers: config.mcpServers,
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
