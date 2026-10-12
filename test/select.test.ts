import { describe, expect, test } from "vitest";
import { groupAdvantages, qaReward, rgReward } from "../src/core/reward.ts";
import { type ScoredCandidate, selectNext } from "../src/core/select.ts";

const parent = { source: "P", score: 0.5 };
const c = (
	index: number,
	status: ScoredCandidate["status"],
	score: number | null,
	completedFraction = 1,
): ScoredCandidate => ({
	index,
	status,
	source: status === "invalid" ? null : status === "no_change" ? "P" : `C${index}`,
	score,
	completedFraction,
});

describe("selectNext greedy (Eq. 7)", () => {
	test("keeps the parent unless a candidate strictly improves", () => {
		expect(selectNext("greedy", parent, [c(0, "edit", 0.5)]).chosen).toBeNull();
		expect(selectNext("greedy", parent, [c(0, "edit", 0.4), c(1, "invalid", null)]).source).toBe("P");
		expect(selectNext("greedy", parent, [c(0, "edit", 0.6), c(1, "edit", 0.7)])).toMatchObject({
			source: "C1",
			score: 0.7,
			chosen: 1,
		});
	});
});

describe("selectNext best-of-g (App. D.3)", () => {
	test("advances to the best candidate even below the parent", () => {
		expect(
			selectNext("best-of-g", parent, [c(0, "edit", 0.3), c(1, "edit", 0.4), c(2, "invalid", null)]),
		).toMatchObject({
			source: "C1",
			score: 0.4,
			chosen: 1,
		});
	});

	test("keeps the parent only when every candidate fails", () => {
		const s = selectNext("best-of-g", parent, [c(0, "invalid", null), c(1, "edit", 0, 0)]);
		expect(s.chosen).toBeNull();
		expect(s.source).toBe("P");
	});

	test("breaks ties by the earliest candidate", () => {
		expect(selectNext("best-of-g", parent, [c(0, "edit", 0.6), c(1, "edit", 0.6)]).chosen).toBe(0);
	});
});

describe("rewards", () => {
	test("Eq. 8 validity terms", () => {
		expect(rgReward({ parsed: true, applied: true, completedFraction: 1, score: 0 })).toBeCloseTo(0.3);
		expect(rgReward({ parsed: true, applied: false, completedFraction: 0, score: 0 })).toBeCloseTo(0.05);
		expect(rgReward({ parsed: true, applied: true, completedFraction: 0.5, score: 0.8 })).toBeCloseTo(1.025);
	});

	test("Eq. 11", () => {
		expect(qaReward({ valid: true, score: 0.4 })).toBeCloseTo(0.5);
		expect(qaReward({ valid: false, score: 0.4 })).toBe(0);
	});

	test("group advantages are normalized", () => {
		const a = groupAdvantages([1, 0, 0, 1]);
		expect(a[0]).toBeCloseTo(1, 4);
		expect(a[1]).toBeCloseTo(-1, 4);
		expect(groupAdvantages([0.5, 0.5])).toEqual([0, 0]);
	});
});
