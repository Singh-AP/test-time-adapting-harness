/** Reasoning Gym reward: Eq. 6 with the Eq. 8 validity terms. Failed edits earn only accrued validity credit. */
export function rgReward(p: { parsed: boolean; applied: boolean; completedFraction: number; score: number }): number {
	const validity = 0.05 * Number(p.parsed) + 0.1 * Number(p.applied) + 0.15 * (p.applied ? p.completedFraction : 0);
	return (p.applied ? p.score : 0) + validity;
}

/** Multi-hop QA reward (Eq. 11). */
export function qaReward(p: { valid: boolean; score: number }): number {
	return p.valid ? p.score + 0.1 : 0;
}

/** GRPO group-normalized advantages (r_i - mean) / (std + δ). */
export function groupAdvantages(rewards: readonly number[], delta = 1e-6): number[] {
	if (rewards.length === 0) return [];
	const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
	const variance = rewards.reduce((a, r) => a + (r - mean) ** 2, 0) / rewards.length;
	const std = Math.sqrt(variance);
	return rewards.map((r) => (r - mean) / (std + delta));
}
