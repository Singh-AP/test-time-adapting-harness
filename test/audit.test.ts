import { describe, expect, test } from "vitest";
import { classifyHarness } from "../src/learning/audit.ts";

describe("classifyHarness", () => {
	test("no solver calls is an algorithm, whether it runs in JavaScript or Python", () => {
		expect(classifyHarness({ llm: 0, python: 0, search: 0 })).toBe("algorithm-js");
		expect(classifyHarness({ llm: 0.01, python: 1, search: 0 })).toBe("algorithm-python");
	});

	test("solver calls plus python is an interpreter loop", () => {
		expect(classifyHarness({ llm: 4.1, python: 0.7, search: 0 })).toBe("interpreter");
	});

	test("solver-only harnesses are single- or multi-call; retrieval wins when searching", () => {
		expect(classifyHarness({ llm: 1, python: 0, search: 0 })).toBe("single-call");
		expect(classifyHarness({ llm: 10, python: 0, search: 0 })).toBe("multi-call");
		expect(classifyHarness({ llm: 4, python: 0, search: 2 })).toBe("retrieval");
	});
});
