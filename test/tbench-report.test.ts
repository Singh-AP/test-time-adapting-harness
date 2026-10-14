import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildTbenchReport, loadTrials } from "../src/tbench/report.ts";

async function fakeJob() {
	const job = await mkdtemp(join(tmpdir(), "tta-tbench-job-"));
	const trial = async (
		name: string,
		task: string,
		reward: number,
		tests: { name: string; status: string }[],
		extra: Record<string, unknown> = {},
	) => {
		const dir = join(job, name);
		await mkdir(join(dir, "agent"), { recursive: true });
		await mkdir(join(dir, "verifier"), { recursive: true });
		await writeFile(join(dir, "config.json"), JSON.stringify({ task: { name: `terminal-bench/${task}` } }));
		await writeFile(join(dir, "result.json"), JSON.stringify({ verifier_result: { rewards: { reward } }, ...extra }));
		await writeFile(
			join(dir, "agent", "agent-config.json"),
			JSON.stringify({ instruction: `Instruction for ${task}: build the thing.`, timeBudgetSec: 28800 }),
		);
		await writeFile(
			join(dir, "agent", "agent-result.json"),
			JSON.stringify({
				stopReason: "completed",
				turns: 12,
				toolCalls: 11,
				elapsedSec: 600,
				cost: 1.5,
				finalText: `Summary for ${task}`,
				reviews: [{ round: 1, verdict: "pass", pass: true, issues: "" }],
			}),
		);
		await writeFile(join(dir, "agent", "transcript.md"), `## user\nstart\n\n## assistant\nlast words of ${task}\n`);
		await writeFile(join(dir, "verifier", "ctrf.json"), JSON.stringify({ results: { tests } }));
		await writeFile(join(dir, "verifier", "test-stdout.txt"), `FAILED tests for ${task}: assert 1 == 2\n`);
	};
	await trial("alpha__1", "alpha", 1, [{ name: "test_a", status: "passed" }]);
	await trial("beta__1", "beta", 0, [
		{ name: "test_b1", status: "passed" },
		{ name: "test_b2", status: "failed" },
	]);
	await trial("gamma__1", "gamma", 0, [], { exception_info: { exception_type: "AgentTimeoutError" } });
	return job;
}

describe("tbench report", () => {
	test("loads trials with tests, summaries and reviews", async () => {
		const trials = await loadTrials([await fakeJob()]);
		expect(trials.map((t) => [t.task, t.reward])).toEqual([
			["terminal-bench/alpha", 1],
			["terminal-bench/beta", 0],
			["terminal-bench/gamma", 0],
		]);
		const beta = trials[1];
		expect(beta.failedTests).toEqual(["test_b2"]);
		expect(beta.passedTests).toBe(1);
		expect(beta.instruction).toContain("Instruction for beta");
		expect(beta.finalText).toBe("Summary for beta");
		expect(trials[2].exception).toBe("AgentTimeoutError");
	});

	test("report covers failures in detail and restricts tasks to the allowed set", async () => {
		const trials = await loadTrials([await fakeJob()]);
		const report = buildTbenchReport(trials, {
			allowedTasks: new Set(["terminal-bench/alpha", "terminal-bench/beta"]),
		});
		expect(report).toContain("1/2 tasks solved");
		expect(report).toContain("beta");
		expect(report).toContain("test_b2");
		expect(report).toContain("assert 1 == 2");
		expect(report).toContain("last words of beta");
		expect(report).toContain("10 of 480 budget minutes used");
		expect(report).not.toContain("gamma");
	});
});
