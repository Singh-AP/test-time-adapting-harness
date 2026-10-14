import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { proposeHarness, screenHarnessDir } from "../src/tbench/propose.ts";

const V1 = join(import.meta.dirname, "..", "harnesses", "tbench", "v1");

async function copyOfV1() {
	const dir = await mkdtemp(join(tmpdir(), "tta-harness-copy-"));
	await cp(V1, dir, { recursive: true });
	return dir;
}

async function fauxRuntime(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const dir = await mkdtemp(join(tmpdir(), "tta-propose-rt-"));
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

describe("screenHarnessDir", () => {
	test("accepts the v1 harness", async () => {
		expect(await screenHarnessDir(await copyOfV1(), { forbidden: ["alpha-task"] })).toEqual({ ok: true });
	});

	test("rejects forbidden strings such as dev task or test names", async () => {
		const dir = await copyOfV1();
		await writeFile(join(dir, "system.md"), "Watch out for the Alpha-Task edge case.");
		const r = await screenHarnessDir(dir, { forbidden: ["alpha-task"] });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("alpha-task");
	});

	test("rejects malformed settings and missing placeholders", async () => {
		const dir = await copyOfV1();
		await writeFile(join(dir, "harness.json"), "{ not json");
		expect((await screenHarnessDir(dir, { forbidden: [] })).ok).toBe(false);
		const dir2 = await copyOfV1();
		await writeFile(join(dir2, "user.md"), "No placeholder here.");
		const r = await screenHarnessDir(dir2, { forbidden: [] });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("{{instruction}}");
	});
});

describe("proposeHarness", () => {
	test("edits the harness in a workspace and writes the result to outDir", async () => {
		const { runtime, model } = await fauxRuntime([
			fauxAssistantMessage([fauxToolCall("read", { path: "REPORT.md" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "finish.md",
						edits: [{ oldText: "Before you finish", newText: "Before you finish, slowly" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("check_harness", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("## Diagnosis\nAgents stop early.\n## Change manifest\nSlower finish check.")]),
		]);
		const outDir = join(await mkdtemp(join(tmpdir(), "tta-propose-out-")), "v2");
		const result = await proposeHarness({
			runtime,
			model,
			thinkingLevel: "off",
			parentDir: V1,
			outDir,
			report: "## Development results\n1/2 tasks solved.",
			forbidden: ["beta-task"],
		});
		expect(result.status).toBe("edit");
		expect(result.manifest).toBe("Slower finish check.");
		expect(await readFile(join(outDir, "finish.md"), "utf8")).toContain("Before you finish, slowly");
		expect(await readFile(join(outDir, "CHANGES.md"), "utf8")).toContain("Slower finish check.");
		const parentFinish = await readFile(join(V1, "finish.md"), "utf8");
		expect(parentFinish).not.toContain("slowly");
	});

	test("an unchanged harness is no_change", async () => {
		const { runtime, model } = await fauxRuntime([fauxAssistantMessage([fauxText("NO_CHANGE: nothing to fix")])]);
		const outDir = join(await mkdtemp(join(tmpdir(), "tta-propose-out-")), "v2");
		const result = await proposeHarness({
			runtime,
			model,
			thinkingLevel: "off",
			parentDir: V1,
			outDir,
			report: "x",
			forbidden: [],
		});
		expect(result.status).toBe("no_change");
	});
});
