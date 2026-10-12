import { errorMessage } from "../util/text.ts";
import type { Budgets } from "./capabilities.ts";
import { applyEdits, parseProposal } from "./edits.ts";
import { proposerSystemPrompt, retryPrompt, revisionPrompt } from "./prompts.ts";
import type { ScreenResult } from "./screens.ts";
import type { CapabilityName, ProposerClient, SolverMessage, TaskInfo, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export type ProposalStatus = "edit" | "no_change" | "invalid";

export interface Proposal {
	status: ProposalStatus;
	/** Revised harness when status is "edit". */
	source?: string;
	diagnosis?: string;
	manifest?: string;
	/** No-change reason, or the last error when invalid. */
	reason?: string;
	attempts: number;
	/** Some response parsed into edits or a full harness (validity reward term). */
	parsed: boolean;
	/** The final edit applied and passed screening (validity reward term). */
	applied: boolean;
	errors: string[];
	system: string;
	transcript: SolverMessage[];
	usage: Usage;
}

export interface ProposeOptions {
	client: ProposerClient;
	task: TaskInfo;
	capabilities: readonly CapabilityName[];
	budgets: Budgets;
	parentSource: string;
	parentScore: number;
	feedbackSize: number;
	report: string;
	maxLines: number;
	/** Generation attempts; invalid responses receive error feedback and retry (paper App. B.1). */
	attempts: number;
	branch?: { index: number; total: number };
	screen: (source: string) => Promise<ScreenResult>;
	signal?: AbortSignal;
}

/** Samples one revision y ~ π(·|x), applies it, and screens the result. */
export async function propose(o: ProposeOptions): Promise<Proposal> {
	const system = proposerSystemPrompt({ capabilities: o.capabilities, budgets: o.budgets, maxLines: o.maxLines });
	const messages: SolverMessage[] = [
		{
			role: "user",
			content: revisionPrompt({
				task: o.task,
				source: o.parentSource,
				score: o.parentScore,
				feedbackSize: o.feedbackSize,
				report: o.report,
				branch: o.branch,
			}),
		},
	];
	const parent = o.parentSource.replace(/\r\n/g, "\n");
	const usage = emptyUsage();
	const errors: string[] = [];
	let parsedAny = false;
	const finish = (status: ProposalStatus, attempts: number, extra: Partial<Proposal> = {}): Proposal => ({
		status,
		attempts,
		parsed: parsedAny,
		applied: status === "edit",
		errors,
		system,
		transcript: messages,
		usage,
		...extra,
	});

	for (let attempt = 1; attempt <= o.attempts; attempt++) {
		let text: string;
		try {
			const response = await o.client.complete({ system, messages: [...messages] }, o.signal);
			addUsage(usage, response.usage);
			if (response.stopReason === "error" || response.error) {
				errors.push(`proposer model error: ${response.error ?? "unknown error"}`);
				continue;
			}
			text = response.text;
		} catch (error) {
			errors.push(`proposer model error: ${errorMessage(error)}`);
			continue;
		}
		messages.push({ role: "assistant", content: text });
		const parsed = parseProposal(text);
		if (parsed.kind === "no_change") return finish("no_change", attempt, { reason: parsed.reason });
		let failure: string;
		if (parsed.kind === "unparseable") {
			failure = parsed.error;
		} else {
			parsedAny = true;
			const applied =
				parsed.kind === "full" ? { ok: true as const, source: parsed.source } : applyEdits(parent, parsed.blocks);
			if (!applied.ok) {
				failure = applied.error;
			} else if (applied.source === parent) {
				return finish("no_change", attempt, {
					reason: "the edits left the harness unchanged",
					diagnosis: parsed.diagnosis,
					manifest: parsed.manifest,
				});
			} else {
				const screened = await o.screen(applied.source);
				if (screened.ok) {
					return finish("edit", attempt, {
						source: applied.source,
						diagnosis: parsed.diagnosis,
						manifest: parsed.manifest,
					});
				}
				failure = screened.reason;
			}
		}
		errors.push(failure);
		if (attempt < o.attempts) messages.push({ role: "user", content: retryPrompt(failure) });
	}
	return finish("invalid", o.attempts, { reason: errors[errors.length - 1] ?? "no usable response" });
}
