import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { repoPath } from "../config.ts";
import type { AdaptSummary } from "../core/loop.ts";
import { fmt } from "../util/text.ts";
import { type AdaptRequest, type AdaptService, createAdaptService } from "./service.ts";

const USAGE =
	"Usage: /adapt <task> [--rounds N] [--proposals G] [--protocol rg|qa] [--solver ID] [--proposer ID] [--reasoning LEVEL] [--dev N] [--heldout N] [--seed-harness FILE] [--run-dir DIR]";

const NUMERIC = new Set(["rounds", "proposals", "dev", "heldout"]);
const KEYS: Record<string, keyof AdaptRequest> = {
	rounds: "rounds",
	proposals: "proposals",
	protocol: "protocol",
	solver: "solver",
	proposer: "proposer",
	reasoning: "reasoning",
	dev: "dev",
	heldout: "heldout",
	"seed-harness": "seedHarness",
	"run-dir": "runDir",
};

export function parseAdaptArgs(args: string): AdaptRequest {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const task = words.shift();
	if (!task || task.startsWith("--")) throw new Error(USAGE);
	const request: Record<string, unknown> = { task };
	while (words.length > 0) {
		const flag = words.shift() as string;
		const name = flag.replace(/^--/, "");
		const key = KEYS[name];
		const value = words.shift();
		if (!flag.startsWith("--") || !key || value === undefined)
			throw new Error(`Unknown or incomplete option ${flag}. ${USAGE}`);
		if (NUMERIC.has(name)) {
			const n = Number(value);
			if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} expects a non-negative integer. ${USAGE}`);
			request[key] = n;
		} else request[key] = value;
	}
	return request as unknown as AdaptRequest;
}

export function formatSummary(s: AdaptSummary): string {
	const score = (x: number | undefined) => (x === undefined ? "-" : fmt(x));
	const rounds = s.rounds.map((r) => `- round ${r.round}: ${r.selection.reason}; held-out ${score(r.heldout)}`);
	const cost = s.usage.solver.cost + s.usage.proposer.cost;
	return [
		`Adapted ${s.task}: held-out ${score(s.seedHeldout)} -> ${score(s.finalHeldout)}.`,
		...rounds,
		`Cost $${cost.toFixed(2)} (solver ${s.usage.solver.calls} calls, proposer ${s.usage.proposer.calls} calls). Final harness: ${join(s.runDir, "final.js")}.`,
	].join("\n");
}

/** pi extension: test-time harness adaptation as a tool and commands. */
export function createAdaptExtension(service: AdaptService = createAdaptService()) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "adapt_harness",
			label: "Adapt harness",
			description:
				"Adapt an agent harness to a task at test time (harness learning): a proposer model revises the harness program from execution feedback on development questions, and held-out scores are reported every round. Tasks: toy:addition, rg:<reasoning-gym family>, qa:hotpotqa|musique|2wiki. Runs can take minutes.",
			parameters: Type.Object({
				task: Type.String({ description: "Task spec, for example rg:maze or qa:hotpotqa" }),
				rounds: Type.Optional(Type.Integer({ minimum: 1, description: "Revision rounds" })),
				proposals: Type.Optional(Type.Integer({ minimum: 1, description: "Proposals per round" })),
				protocol: Type.Optional(Type.Union([Type.Literal("rg"), Type.Literal("qa")])),
				solver: Type.Optional(
					Type.String({ description: "Solver model: provider/model, or a bare Amazon Bedrock id" }),
				),
				proposer: Type.Optional(
					Type.String({ description: "Proposer model: provider/model, or a bare Amazon Bedrock id" }),
				),
				dev: Type.Optional(Type.Integer({ minimum: 1 })),
				heldout: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			execute: async (_id, params, signal, onUpdate) => {
				const summary = await service.run(
					params as AdaptRequest,
					(line) => onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }),
					signal,
				);
				return {
					content: [{ type: "text", text: formatSummary(summary) }],
					details: {
						runDir: summary.runDir,
						seedHeldout: summary.seedHeldout,
						finalHeldout: summary.finalHeldout,
					},
				};
			},
		});

		pi.registerCommand("adapt", {
			description: "Adapt a harness to a task at test time. /adapt <task> [--rounds N] ...",
			handler: async (args, ctx) => {
				let request: AdaptRequest;
				try {
					request = parseAdaptArgs(args);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				ctx.ui.notify(`Adapting ${request.task}; progress appears in the status line.`, "info");
				try {
					const summary = await service.run(request, (line) => ctx.ui.setStatus("adapt", line));
					pi.sendMessage({ customType: "adapt-result", content: formatSummary(summary), display: true });
				} catch (error) {
					ctx.ui.notify(`Adaptation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					ctx.ui.setStatus("adapt", undefined);
				}
			},
		});

		pi.registerCommand("harness-runs", {
			description: "List test-time adaptation runs and their held-out scores",
			handler: async (_args, ctx) => {
				const dir = repoPath("runs");
				const names = (await readdir(dir).catch(() => [] as string[])).sort().slice(-20);
				const lines: string[] = [];
				for (const name of names) {
					const summary = await readFile(join(dir, name, "summary.json"), "utf8").catch(() => undefined);
					if (!summary) continue;
					const s = JSON.parse(summary) as AdaptSummary;
					lines.push(
						`${name}: ${s.task} ${s.seedHeldout?.toFixed(3) ?? "-"} -> ${s.finalHeldout?.toFixed(3) ?? "-"}`,
					);
				}
				ctx.ui.notify(lines.length ? lines.join("\n") : "No completed runs.", "info");
			},
		});
	};
}

export default createAdaptExtension();
