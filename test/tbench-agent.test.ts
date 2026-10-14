import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { runTerminalAgent } from "../src/tbench/agent.ts";
import { type Harness, loadHarness } from "../src/tbench/harness.ts";
import type { RemoteEnvironment } from "../src/tbench/remote.ts";

const run = promisify(execFile);

async function localEnvironment() {
	const root = await mkdtemp(join(tmpdir(), "tta-agent-env-"));
	const commands: string[] = [];
	const env: RemoteEnvironment = {
		exec: async (command) => {
			commands.push(command);
			try {
				const { stdout, stderr } = await run("bash", ["-c", command]);
				return { stdout, stderr, returnCode: 0 };
			} catch (error) {
				const e = error as { stdout?: string; stderr?: string; code?: number };
				return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", returnCode: Number(e.code ?? 1) };
			}
		},
		upload: async (path, content) => writeFile(path, content),
		download: async (path) => readFile(path),
	};
	return { env, root, commands };
}

async function fauxRuntime(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const dir = await mkdtemp(join(tmpdir(), "tta-agent-rt-"));
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
	const faux = fauxProvider();
	runtime.registerNativeProvider(faux.provider);
	faux.setResponses(steps);
	return { runtime, model: faux.getModel() };
}

function testHarness(extra: Partial<Harness> = {}): Harness {
	return {
		name: "test",
		systemPrompt: "You are a careful terminal agent.",
		userPrompt: "# Task\n{{instruction}}\n\n# Environment\n{{environment}}",
		probe: "echo PROBE-OK; uname -s",
		finishCheck: "FINISH CHECK: confirm every requirement is met.",
		maxFinishChecks: 1,
		thinkingLevel: "off",
		bash: { defaultTimeoutSec: 30, maxTimeoutSec: 60, headBytes: 4000, tailBytes: 4000 },
		contextWindow: 200_000,
		compaction: { enabled: false, reserveTokens: 16_000, keepRecentTokens: 20_000 },
		timeWarnings: [],
		...extra,
	};
}

describe("runTerminalAgent", () => {
	test("probes the environment, runs tools remotely, asks the finish check once, and logs the session", async () => {
		const { env, root, commands } = await localEnvironment();
		const { runtime, model } = await fauxRuntime([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo working > result.txt && cat result.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Done: wrote result.txt")]),
			fauxAssistantMessage([fauxToolCall("read", { path: "result.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Verified result.txt contains the expected text.")]),
		]);
		const logsDir = await mkdtemp(join(tmpdir(), "tta-agent-logs-"));
		const usage: number[] = [];
		const result = await runTerminalAgent({
			instruction: "Write result.txt",
			env,
			runtime,
			model,
			harness: testHarness(),
			timeBudgetSec: 600,
			cwd: root,
			logsDir,
			onUsage: (u) => usage.push(u.turns),
		});
		expect(result.stopReason).toBe("completed");
		expect(result.finishChecks).toBe(1);
		expect(result.toolCalls).toBe(2);
		expect(await readFile(join(root, "result.txt"), "utf8")).toBe("working\n");
		expect(commands.some((c) => c.includes(Buffer.from("echo PROBE-OK; uname -s").toString("base64")))).toBe(true);
		const transcript = await readFile(join(logsDir, "transcript.md"), "utf8");
		expect(transcript).toContain("PROBE-OK");
		expect(transcript).toContain("FINISH CHECK");
		expect(transcript).toContain("Verified result.txt");
		const saved = JSON.parse(await readFile(join(logsDir, "agent-result.json"), "utf8"));
		expect(saved.stopReason).toBe("completed");
		expect(usage.length).toBeGreaterThan(0);
	});

	test("stops at the deadline", async () => {
		const { env, root } = await localEnvironment();
		const { runtime, model } = await fauxRuntime([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2; echo late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("never reached")]),
		]);
		const result = await runTerminalAgent({
			instruction: "Wait",
			env,
			runtime,
			model,
			harness: testHarness({ finishCheck: "" }),
			timeBudgetSec: 1,
			safetyMarginSec: 0,
			cwd: root,
		});
		expect(result.stopReason).toBe("deadline");
	});
});

describe("independent review", () => {
	test("a failed review sends the issues back to the agent until a review passes", async () => {
		const { env, root } = await localEnvironment();
		const { runtime, model } = await fauxRuntime([
			fauxAssistantMessage([fauxText("Done.")]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("VERDICT: FAIL\n1. answer.txt is missing (ls shows nothing).")]),
			fauxAssistantMessage([fauxToolCall("write", { path: "answer.txt", content: "42\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Fixed: wrote answer.txt.")]),
			fauxAssistantMessage([fauxText("VERDICT: PASS")]),
		]);
		const logsDir = await mkdtemp(join(tmpdir(), "tta-review-logs-"));
		const result = await runTerminalAgent({
			instruction: "Write 42 to answer.txt",
			env,
			runtime,
			model,
			harness: testHarness({
				finishCheck: "",
				review: {
					prompt: "You are the reviewer.",
					request: "TASK:\n{{instruction}}\nAGENT SUMMARY:\n{{summary}}",
					followup: "REVIEW ISSUES:\n{{issues}}",
					maxRounds: 3,
					minTimeLeftSec: 0,
				},
			}),
			timeBudgetSec: 600,
			cwd: root,
			logsDir,
		});
		expect(result.stopReason).toBe("completed");
		expect(result.reviews.map((r) => r.pass)).toEqual([false, true]);
		expect(result.reviews[0].issues).toContain("answer.txt is missing");
		expect(await readFile(join(root, "answer.txt"), "utf8")).toBe("42\n");
		const transcript = await readFile(join(logsDir, "transcript.md"), "utf8");
		expect(transcript).toContain("REVIEW ISSUES:");
		const review = await readFile(join(logsDir, "review-1.md"), "utf8");
		expect(review).toContain("Write 42 to answer.txt");
		expect(review).toContain("VERDICT: FAIL");
	});

	test("a review without a verdict ends the loop", async () => {
		const { env, root } = await localEnvironment();
		const { runtime, model } = await fauxRuntime([
			fauxAssistantMessage([fauxText("Done.")]),
			fauxAssistantMessage([fauxText("I could not decide.")]),
		]);
		const result = await runTerminalAgent({
			instruction: "x",
			env,
			runtime,
			model,
			harness: testHarness({
				finishCheck: "",
				review: {
					prompt: "R",
					request: "{{instruction}}",
					followup: "{{issues}}",
					maxRounds: 2,
					minTimeLeftSec: 0,
				},
			}),
			timeBudgetSec: 600,
			cwd: root,
		});
		expect(result.reviews).toHaveLength(1);
		expect(result.reviews[0].pass).toBe(true);
		expect(result.reviews[0].verdict).toBe("none");
	});
});

describe("loadHarness", () => {
	test("reads harness.json with prompt files and fills defaults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tta-harness-"));
		await writeFile(join(dir, "system.md"), "SYSTEM");
		await writeFile(join(dir, "user.md"), "{{instruction}}");
		await writeFile(join(dir, "probe.sh"), "uname -a");
		await writeFile(join(dir, "harness.json"), JSON.stringify({ name: "x", thinkingLevel: "high" }));
		const h = await loadHarness(dir);
		expect(h.name).toBe("x");
		expect(h.systemPrompt).toBe("SYSTEM");
		expect(h.probe).toBe("uname -a");
		expect(h.finishCheck).toBe("");
		expect(h.thinkingLevel).toBe("high");
		expect(h.bash.defaultTimeoutSec).toBeGreaterThan(0);
	});
});
