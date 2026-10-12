/** Structural classes of harnesses (paper Fig. 6b), from average calls per question. */
export type HarnessClass =
	| "algorithm-js"
	| "algorithm-python"
	| "interpreter"
	| "multi-call"
	| "single-call"
	| "retrieval";

/**
 * algorithm: the harness computes answers itself (fewer than 0.2 solver calls), in JavaScript or in Python it
 * wrote; interpreter: solver calls combined with python execution (the solver writes code the harness runs);
 * retrieval: search calls; otherwise single- or multi-call solver orchestration.
 */
export function classifyHarness(calls: { llm: number; python: number; search: number }): HarnessClass {
	if (calls.search > 0) return "retrieval";
	if (calls.llm < 0.2) return calls.python >= 0.5 ? "algorithm-python" : "algorithm-js";
	if (calls.python >= 0.5) return "interpreter";
	return calls.llm > 1.5 ? "multi-call" : "single-call";
}
