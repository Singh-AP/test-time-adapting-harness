import { fmt } from "../util/text.ts";
import type { ProposalStatus } from "./proposer.ts";

export type SelectionProtocol = "greedy" | "best-of-g";

export interface ScoredCandidate {
	index: number;
	status: ProposalStatus;
	/** Candidate source; the parent's source for no-change; null when invalid. */
	source: string | null;
	/** J(h'; Q_score), or null when invalid. */
	score: number | null;
	completedFraction: number;
}

export interface Selection {
	source: string;
	score: number;
	/** Index of the retained candidate, or null when the parent is kept. */
	chosen: number | null;
	reason: string;
}

/**
 * Select(h_{t-1}, {h'_i}; Q_score).
 * greedy: keep the best candidate only if it strictly beats the parent (Reasoning Gym, Eq. 7).
 * best-of-g: advance to the best runnable candidate even below the parent; keep the parent only if all fail (QA, App. D.3).
 */
export function selectNext(
	protocol: SelectionProtocol,
	parent: { source: string; score: number },
	candidates: readonly ScoredCandidate[],
): Selection {
	const usable = candidates.filter((c) => c.status !== "invalid" && c.source !== null && c.score !== null);
	if (protocol === "greedy") {
		let best: ScoredCandidate | undefined;
		for (const c of usable) {
			if (
				c.status === "edit" &&
				(c.score as number) > parent.score &&
				(!best || (c.score as number) > (best.score as number))
			) {
				best = c;
			}
		}
		if (!best)
			return {
				source: parent.source,
				score: parent.score,
				chosen: null,
				reason: "no candidate improved on the parent",
			};
		return {
			source: best.source as string,
			score: best.score as number,
			chosen: best.index,
			reason: `candidate ${best.index} improved ${fmt(parent.score)} -> ${fmt(best.score as number)}`,
		};
	}
	const runnable = usable.filter((c) => c.status === "no_change" || c.completedFraction > 0);
	if (runnable.length === 0) {
		return {
			source: parent.source,
			score: parent.score,
			chosen: null,
			reason: "every candidate failed to parse or run",
		};
	}
	let best = runnable[0];
	for (const c of runnable) if ((c.score as number) > (best.score as number)) best = c;
	if (best.status === "no_change") {
		return {
			source: parent.source,
			score: best.score as number,
			chosen: null,
			reason: `no-change proposal ${best.index} scored highest`,
		};
	}
	return {
		source: best.source as string,
		score: best.score as number,
		chosen: best.index,
		reason: `advanced to candidate ${best.index} (${fmt(best.score as number)}; parent ${fmt(parent.score)})`,
	};
}
