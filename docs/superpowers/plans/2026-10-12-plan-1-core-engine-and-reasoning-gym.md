# Plan 1: Core Adaptation Engine and Reasoning Gym — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working test-time harness adaptation engine (paper Eq. 4) on pi packages, with Bedrock models, offline unit tests, a CLI, and real end-to-end runs on Reasoning Gym families.

**Architecture:** Harnesses are JavaScript programs executed per question in pi-codemode's QuickJS sandbox; their only capabilities are host-injected, budgeted, traced globals (`llm`, `python`, `search`, `log`). An executor scores a harness on a question set; a report builder turns traces into the paper's execution report; a proposer (Bedrock Claude via pi-ai) returns SEARCH/REPLACE edits; screens validate candidates; a selection protocol retains a harness each round; the loop writes artifacts under `runs/`.

**Tech Stack:** Node ≥ 22.19 with TypeScript type stripping (no build), `@earendil-works/pi-ai` 1.1.0 (Bedrock provider), `@earendil-works/pi-codemode` 1.1.0, `diff` 9.0.0, vitest 5.0.3, TypeScript 7.0.2 for `tsc --noEmit`, Biome 2.3.5, Python 3.12 venv with `reasoning-gym` 0.1.19.

**Spec:** `docs/superpowers/specs/2026-10-12-test-time-adapting-harness-design.md`

## Global Constraints

- Node `>=22.19.0`; ESM (`"type": "module"`); relative imports end in `.ts`; only erasable TypeScript syntax (no enums, namespaces, parameter properties).
- Direct dependencies pinned to exact versions.
- Bedrock credentials come only from the ambient AWS credential chain (`AWS_PROFILE=<aws-profile>`); no credential values in code, logs, artifacts, or child-process environments.
- Held-out questions (`Task.heldout`) are never passed to the report builder, the proposer, or the selection rule.
- Harness source runs only inside pi-codemode; solver-written Python runs only through `python/guard.py` with a scrubbed environment.
- Every task ends with `npm test` and `npm run check` passing, then a commit and a push to `origin main`.
- Formatting: Biome with tabs, indent width 3, line width 120 (as in pi).

## Review Focus

1. A harness that loops forever or awaits a promise that never settles: that question times out with kind `timeout`, the evaluation continues. Pinned in Task 3 (`times out an infinite loop`).
2. Proposer replies with CRLF line endings, indentation drift, duplicated SEARCH text, or `$&` in replacements: edits apply exactly or fail with a precise message; the parent is never corrupted. Pinned in Task 5.
3. Bedrock throttling mid-run: retried with backoff; a persistent failure fails only the affected question. Pinned in Task 11 (`retries throttling then succeeds`, `does not retry validation errors`).
4. Held-out leakage: no held-out question text appears in any proposer request across a full loop. Pinned in Task 10 (`never shows held-out questions to the proposer`).
5. Solver-written Python reaching the network, spawning processes, reading credential files, or seeing AWS environment variables: blocked. Pinned in Task 12.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test` (vitest), `npm run check` (biome + tsc), `npm run tta` (CLI, Task 14).

- [ ] **Step 1: Write the scaffold files**

**File: `package.json`**
```json
{
	"name": "test-time-adapting-harness",
	"version": "0.1.0",
	"description": "Test-time harness adaptation (Harness Learning, arXiv:2609.35738) built on the pi agent toolkit",
	"type": "module",
	"license": "MIT",
	"engines": {
		"node": ">=22.19.0"
	},
	"bin": {
		"tta": "./src/cli.ts"
	},
	"scripts": {
		"test": "vitest run",
		"check": "biome check --write src test && tsc --noEmit",
		"tta": "node src/cli.ts"
	},
	"dependencies": {
		"@earendil-works/pi-ai": "1.1.0",
		"@earendil-works/pi-codemode": "1.1.0",
		"diff": "9.0.0"
	},
	"devDependencies": {
		"@biomejs/biome": "2.3.5",
		"@types/node": "22.19.19",
		"typescript": "7.0.2",
		"vitest": "5.0.3"
	}
}
```

**File: `tsconfig.json`**
```json
{
	"compilerOptions": {
		"target": "ES2024",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"lib": ["ES2024"],
		"strict": true,
		"erasableSyntaxOnly": true,
		"verbatimModuleSyntax": true,
		"allowImportingTsExtensions": true,
		"noEmit": true,
		"skipLibCheck": true,
		"resolveJsonModule": true,
		"types": ["node"]
	},
	"include": ["src", "test", "experiments"]
}
```

**File: `biome.json`**
```json
{
	"$schema": "https://biomejs.dev/schemas/2.3.5/schema.json",
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true,
			"style": {
				"noNonNullAssertion": "off",
				"useConst": "error",
				"useNodejsImportProtocol": "off"
			},
			"suspicious": {
				"noExplicitAny": "off",
				"noControlCharactersInRegex": "off"
			}
		}
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab",
		"indentWidth": 3,
		"lineWidth": 120
	},
	"files": {
		"includes": ["src/**/*.ts", "test/**/*.ts", "experiments/**/*.ts"]
	}
}
```

**File: `vitest.config.ts`**
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
```

**File: `.gitignore`**
```
node_modules/
runs/
data/
.venv/
*.log
.env
.DS_Store
```

**File: `README.md`**
```markdown
# test-time-adapting-harness

An agent harness that adapts itself at test time, following *Harness Learning Enables Generalizable
Test-Time Adaptation* (Zhang et al., arXiv:2609.35738), built on the [pi](https://github.com/earendil-works/pi)
agent toolkit.

A *harness* is the program that organizes calls to a frozen solver model, tool use and information flow. A
*proposer* model reads the task description, the current harness and an execution report, and edits the
harness. Repeating this on development questions adapts the harness to a new task without changing any model
weights.

Status: under construction. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the
implementation plans.

## Setup

    npm install --ignore-scripts
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python reasoning-gym==0.1.19

## Test

    npm test
    npm run check
```

**Test: `test/smoke.test.ts`**
```ts
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { expect, test } from "vitest";

test("pi-codemode runs a script", async () => {
	const sandbox = new CodemodeSandbox({ timeoutMs: 5000 });
	try {
		const result = await sandbox.execute("return 1 + 1;");
		expect(result.ok && result.value).toBe(2);
	} finally {
		await sandbox.close();
	}
});
```

- [ ] **Step 2: Install and run**

Run: `npm install --ignore-scripts && npm test && npm run check`
Expected: 1 test passes; check reports no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json biome.json vitest.config.ts .gitignore README.md test/smoke.test.ts
git commit -m "feat: project scaffold on pi-ai and pi-codemode"
git push origin main
```

---

### Task 2: Utilities

**Files:**
- Create: `src/util/random.ts`, `src/util/concurrency.ts`, `src/util/text.ts`, `src/util/hash.ts`
- Test: `test/util.test.ts`

**Interfaces:**
- Produces: `createRng(seed: number): () => number`, `shuffle<T>(items, rng): T[]`, `Semaphore` (`run<T>(fn): Promise<T>`), `mapLimit<T, R>(items, limit, fn): Promise<R[]>`, `sleep(ms, signal?)`, `clip(text, max)`, `clipMiddle(text, max)`, `errorMessage(error)`, `fmt(n, digits?)`, `hashSource(source): string`.

- [ ] **Step 1: Write the failing test**

**Test: `test/util.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { mapLimit, Semaphore, sleep } from "../src/util/concurrency.ts";
import { hashSource } from "../src/util/hash.ts";
import { createRng, shuffle } from "../src/util/random.ts";
import { clip, clipMiddle, fmt } from "../src/util/text.ts";

describe("random", () => {
	test("is deterministic per seed", () => {
		const a = createRng(42);
		const b = createRng(42);
		const c = createRng(43);
		const xs = [a(), a(), a()];
		expect([b(), b(), b()]).toEqual(xs);
		expect(c()).not.toBe(xs[0]);
		for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
	});

	test("shuffle is a permutation and does not mutate", () => {
		const items = [1, 2, 3, 4, 5, 6];
		const out = shuffle(items, createRng(1));
		expect([...out].sort()).toEqual(items);
		expect(items).toEqual([1, 2, 3, 4, 5, 6]);
	});
});

describe("concurrency", () => {
	test("mapLimit keeps order and bounds parallelism", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
			active++;
			peak = Math.max(peak, active);
			await sleep(x * 3);
			active--;
			return x * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30]);
		expect(peak).toBe(2);
	});

	test("Semaphore limits concurrent runs", async () => {
		const sem = new Semaphore(1);
		const order: string[] = [];
		await Promise.all([
			sem.run(async () => {
				order.push("a+");
				await sleep(10);
				order.push("a-");
			}),
			sem.run(async () => {
				order.push("b+");
				order.push("b-");
			}),
		]);
		expect(order).toEqual(["a+", "a-", "b+", "b-"]);
	});

	test("sleep rejects when aborted", async () => {
		const controller = new AbortController();
		const pending = sleep(10_000, controller.signal);
		controller.abort(new Error("stop"));
		await expect(pending).rejects.toThrow("stop");
	});
});

describe("text", () => {
	test("clip and clipMiddle", () => {
		expect(clip("abcdef", 10)).toBe("abcdef");
		expect(clip("abcdefghij", 4)).toBe("abcd… [+6 chars]");
		const middle = clipMiddle("x".repeat(50) + "y".repeat(50), 40);
		expect(middle.startsWith("xxxxxxxxxx")).toBe(true);
		expect(middle.endsWith("yyyyyyyyyy")).toBe(true);
		expect(middle).toContain("omitted");
		expect(fmt(0.123456)).toBe("0.123");
	});

	test("hashSource is stable and short", () => {
		expect(hashSource("a")).toBe(hashSource("a"));
		expect(hashSource("a")).not.toBe(hashSource("b"));
		expect(hashSource("a")).toHaveLength(12);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/util.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/util/random.ts`**
```ts
/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
```

**File: `src/util/concurrency.ts`**
```ts
/** Counting semaphore for bounding concurrent async work. */
export class Semaphore {
	private available: number;
	private readonly waiters: (() => void)[] = [];

	constructor(limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
		this.available = limit;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next();
		else this.available++;
	}
}

/** Maps items with at most `limit` calls in flight, preserving input order. */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
```

**File: `src/util/text.ts`**
```ts
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/** Keeps the start and the end of long text. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.max(1, Math.floor((max - 24) / 2));
	return `${text.slice(0, half)} … [${text.length - 2 * half} chars omitted] … ${text.slice(-half)}`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function fmt(value: number, digits = 3): string {
	return value.toFixed(digits);
}
```

**File: `src/util/hash.ts`**
```ts
import { createHash } from "node:crypto";

/** Short content hash used to identify harness versions. */
export function hashSource(source: string): string {
	return createHash("sha256").update(source).digest("hex").slice(0, 12);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/util.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/util test/util.test.ts
git commit -m "feat: utilities for seeded sampling, concurrency, text clipping, hashing"
git push origin main
```

---

### Task 3: Core types, injected capabilities, sandbox runner

**Files:**
- Create: `src/core/types.ts`, `src/core/usage.ts`, `src/core/capabilities.ts`, `src/core/sandbox.ts`
- Test: `test/helpers.ts`, `test/sandbox.test.ts`

**Interfaces:**
- Produces (types): `CapabilityName`, `Question`, `Grade`, `Passage`, `TaskInfo`, `Task`, `Usage`, `OutcomeKind`, `OUTCOME_KINDS`, `TraceEvent`, `QuestionOutcome`, `EvalResult`, `SolverMessage`, `SolverRequest`, `SolverResponse`, `SolverClient`, `ProposerRequest`, `ProposerResponse`, `ProposerClient`, `PythonResult`, `PythonRunOptions`, `PythonRunner`, `SearchBackend`.
- Produces (functions): `emptyUsage()`, `addUsage(total, delta)`, `UsageMeter`; `Budgets`, `DEFAULT_BUDGETS`, `CapabilityDeps`, `normalizeSolverRequest(arg, maxTokensCap)`, `createGlobals(capabilities, deps, budgets, state)`, `newQuestionState()`; `buildProgram(source, task, prompt)`, `runHarness(options): Promise<HarnessRun>`.

- [ ] **Step 1: Write the failing tests**

**Test: `test/helpers.ts`**
```ts
import type {
	ProposerClient,
	ProposerRequest,
	PythonRunner,
	SolverClient,
	SolverRequest,
	Task,
} from "../src/core/types.ts";

export function stubSolver(
	respond: (request: SolverRequest) => string | Promise<string>,
): SolverClient & { requests: SolverRequest[] } {
	const requests: SolverRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			return { text: await respond(request), stopReason: "stop", usage: { input: 10, output: 5, cost: 0.0001 } };
		},
	};
}

export function stubProposer(
	respond: (request: ProposerRequest, call: number) => string | Promise<string>,
): ProposerClient & { requests: ProposerRequest[] } {
	const requests: ProposerRequest[] = [];
	return {
		requests,
		async complete(request) {
			requests.push(request);
			return {
				text: await respond(request, requests.length),
				stopReason: "stop",
				usage: { input: 100, output: 50, cost: 0.01 },
			};
		},
	};
}

export function stubPython(): PythonRunner {
	return {
		async run(code) {
			const match = /print\((\d+)\s*\+\s*(\d+)\)/.exec(code);
			return match
				? { stdout: `${Number(match[1]) + Number(match[2])}\n`, stderr: "", exitCode: 0, timedOut: false }
				: { stdout: "", stderr: "unsupported", exitCode: 1, timedOut: false };
		},
	};
}

/** Last "a + b" in a prompt, or undefined. */
export function sumInPrompt(text: string): number | undefined {
	const matches = [...text.matchAll(/(\d+)\s*\+\s*(\d+)/g)];
	const last = matches[matches.length - 1];
	return last ? Number(last[1]) + Number(last[2]) : undefined;
}

export const TOY_INFO = { name: "toy", description: "toy task" } satisfies Pick<Task, "name" | "description">;
```

**Test: `test/sandbox.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS, normalizeSolverRequest } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { stubPython, stubSolver, TOY_INFO } from "./helpers.ts";

const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };

function run(source: string, prompt = "What is 2 + 3?", overrides: Partial<typeof budgets> = {}) {
	const solver = stubSolver((request) => `Reasoning...\nAnswer: echo ${request.messages.at(-1)?.content.length}`);
	return runHarness({
		source,
		prompt,
		task: TOY_INFO,
		capabilities: ["llm", "python"],
		deps: { solver, python: stubPython() },
		budgets: { ...budgets, ...overrides },
	});
}

describe("runHarness", () => {
	test("runs solve with llm and records a trace", async () => {
		const result = await run(`
async function solve(question) {
	const reply = await llm({ system: "be brief", prompt: question });
	log("reply length", reply.length);
	return reply.split("Answer:").pop().trim();
}`);
		expect(result.error).toBeUndefined();
		expect(result.answer).toBe("echo 14");
		expect(result.calls.llm).toBe(1);
		expect(result.trace.map((e) => e.tool)).toEqual(["llm", "log"]);
		expect(result.trace[0].input).toContain("[system] be brief");
		expect(result.usage.input).toBe(10);
	});

	test("exposes no ambient capabilities", async () => {
		const result = await run(`
async function solve() {
	return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof TASK.name].join(",");
}`);
		expect(result.answer).toBe("undefined,undefined,undefined,undefined,string");
	});

	test("enforces the llm budget", async () => {
		const result = await run(
			`async function solve(q) { for (let i = 0; i < 5; i++) await llm(q); return "done"; }`,
			"q",
			{ llmCalls: 2 },
		);
		expect(result.answer).toBeNull();
		expect(result.error?.kind).toBe("budget");
		expect(result.error?.message).toContain("budget exhausted");
		expect(result.calls.llm).toBe(2);
	});

	test("times out an infinite loop", async () => {
		const result = await run(`async function solve() { while (true) {} }`, "q", { questionTimeoutMs: 500 });
		expect(result.error?.kind).toBe("timeout");
		expect(result.answer).toBeNull();
	});

	test("reports a missing solve function", async () => {
		const result = await run(`function answer() { return 1; }`);
		expect(result.error?.kind).toBe("script");
		expect(result.error?.message).toContain("solve");
	});

	test("coerces non-string answers to JSON", async () => {
		const result = await run(`async function solve() { return [1, "a"]; }`);
		expect(result.answer).toBe('[1,"a"]');
	});

	test("python global passes code and returns output", async () => {
		const result = await run(`async function solve() { const r = await python("print(2 + 3)"); return r.stdout.trim(); }`);
		expect(result.answer).toBe("5");
		expect(result.trace[0].tool).toBe("python");
	});

	test("invalid llm requests surface as script errors", async () => {
		const result = await run(`async function solve() { return await llm({ messages: [{ role: "system", content: "x" }] }); }`);
		expect(result.error?.kind).toBe("script");
		expect(result.error?.message).toContain("role");
	});
});

describe("normalizeSolverRequest", () => {
	test("merges consecutive roles and clamps parameters", () => {
		const request = normalizeSolverRequest(
			{
				system: "s",
				messages: [
					{ role: "user", content: "a" },
					{ role: "user", content: "" },
				],
				prompt: "b",
				temperature: 9,
				maxTokens: 999_999,
			},
			1000,
		);
		expect(request.messages).toEqual([{ role: "user", content: "a\n\n(empty)\n\nb" }]);
		expect(request.temperature).toBe(1.5);
		expect(request.maxTokens).toBe(1000);
		expect(request.system).toBe("s");
	});

	test("rejects an assistant-final conversation", () => {
		expect(() =>
			normalizeSolverRequest(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: "b" },
					],
				},
				100,
			),
		).toThrow("last message");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sandbox.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/types.ts`**
```ts
export type CapabilityName = "llm" | "python" | "search";

export interface Question {
	/** Stable identifier, unique within a task. */
	id: string;
	/** Text passed to the harness as `solve(question)`. */
	prompt: string;
	/** Gold answer: used by graders and shown in feedback reports for development questions. */
	answer: string;
	/** Grader-specific data. */
	meta?: Record<string, unknown>;
}

export interface Grade {
	/** In [0, 1]. */
	score: number;
	detail?: string;
}

export interface Passage {
	id: string;
	title: string;
	text: string;
}

export interface TaskInfo {
	name: string;
	description: string;
}

export interface Task extends TaskInfo {
	capabilities: CapabilityName[];
	/** Development pool: feedback and scoring questions are drawn from it. */
	dev: Question[];
	/** Held-out pool: never shown to the proposer and never used for selection. */
	heldout: Question[];
	grade(question: Question, answer: string): Promise<Grade>;
	/** Task-specific lines for a report example, for example retrieved versus missed supporting documents. */
	describeOutcome?(question: Question, outcome: QuestionOutcome): string | undefined;
	search?: SearchBackend;
	close?(): Promise<void>;
}

export interface Usage {
	input: number;
	output: number;
	cost: number;
}

export type OutcomeKind = "correct" | "partial" | "wrong" | "error" | "timeout" | "budget";

export const OUTCOME_KINDS: readonly OutcomeKind[] = ["correct", "partial", "wrong", "error", "timeout", "budget"];

export type ToolName = "llm" | "python" | "search" | "log";

export type BudgetedTool = "llm" | "python" | "search";

export interface TraceEvent {
	tool: ToolName;
	/** Milliseconds since the question started. */
	at: number;
	durationMs: number;
	input: string;
	output: string;
	error?: string;
	usage?: Usage;
}

export interface QuestionOutcome {
	questionId: string;
	answer: string | null;
	score: number;
	kind: OutcomeKind;
	error?: string;
	gradeDetail?: string;
	trace: TraceEvent[];
	durationMs: number;
	calls: Record<BudgetedTool, number>;
	usage: Usage;
}

export interface EvalResult {
	label: string;
	harnessHash: string;
	/** J(h; Q): mean grader score. */
	mean: number;
	counts: Record<OutcomeKind, number>;
	/** Fraction of questions whose execution finished without error, timeout or budget exhaustion. */
	completedFraction: number;
	outcomes: QuestionOutcome[];
	calls: Record<BudgetedTool, number>;
	usage: Usage;
	durationMs: number;
}

export interface SolverMessage {
	role: "user" | "assistant";
	content: string;
}

export interface SolverRequest {
	system?: string;
	messages: SolverMessage[];
	temperature?: number;
	maxTokens: number;
}

export interface SolverResponse {
	text: string;
	stopReason: string;
	usage: Usage;
}

export interface SolverClient {
	complete(request: SolverRequest, signal?: AbortSignal): Promise<SolverResponse>;
}

export interface ProposerRequest {
	system: string;
	messages: SolverMessage[];
}

export interface ProposerResponse {
	/** Final answer text only; thinking is excluded. */
	text: string;
	stopReason: string;
	usage: Usage;
	error?: string;
}

export interface ProposerClient {
	complete(request: ProposerRequest, signal?: AbortSignal): Promise<ProposerResponse>;
}

export interface PythonResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

export interface PythonRunOptions {
	timeoutMs: number;
	stdin?: string;
	signal?: AbortSignal;
}

export interface PythonRunner {
	run(code: string, options: PythonRunOptions): Promise<PythonResult>;
}

export interface SearchBackend {
	search(query: string, k: number): Promise<Passage[]>;
}
```

**File: `src/core/usage.ts`**
```ts
import type { Usage } from "./types.ts";

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cost: 0 };
}

export function addUsage(total: Usage, delta: Usage): void {
	total.input += delta.input;
	total.output += delta.output;
	total.cost += delta.cost;
}

/** Accumulates model usage for one role (solver or proposer). */
export class UsageMeter {
	readonly total: Usage = emptyUsage();
	calls = 0;

	add(usage: Usage): void {
		addUsage(this.total, usage);
		this.calls++;
	}

	snapshot(): Usage & { calls: number } {
		return { ...this.total, calls: this.calls };
	}
}
```

**File: `src/core/capabilities.ts`**
```ts
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import { clipMiddle, errorMessage } from "../util/text.ts";
import type {
	BudgetedTool,
	CapabilityName,
	PythonResult,
	PythonRunner,
	SearchBackend,
	SolverClient,
	SolverMessage,
	SolverRequest,
	TraceEvent,
} from "./types.ts";

export interface CapabilityDeps {
	solver: SolverClient;
	python?: PythonRunner;
	search?: SearchBackend;
}

export interface Budgets {
	/** Solver calls per question. */
	llmCalls: number;
	pythonCalls: number;
	searchCalls: number;
	/** Wall-clock limit per question, including time spent in calls. */
	questionTimeoutMs: number;
	/** Upper bound on maxTokens for one solver call. */
	maxTokensPerCall: number;
	/** Upper bound on one python() call. */
	pythonTimeoutMs: number;
	/** Upper bound on k for one search() call. */
	searchMaxK: number;
}

export const DEFAULT_BUDGETS: Budgets = {
	llmCalls: 12,
	pythonCalls: 12,
	searchCalls: 12,
	questionTimeoutMs: 300_000,
	maxTokensPerCall: 4096,
	pythonTimeoutMs: 20_000,
	searchMaxK: 20,
};

/** Mutable per-question state shared by the injected globals. */
export interface QuestionState {
	startedAt: number;
	trace: TraceEvent[];
	calls: Record<BudgetedTool, number>;
	budgetExceeded: boolean;
	logEvents: number;
}

export function newQuestionState(): QuestionState {
	return {
		startedAt: Date.now(),
		trace: [],
		calls: { llm: 0, python: 0, search: 0 },
		budgetExceeded: false,
		logEvents: 0,
	};
}

export const TRACE_CHARS = 4000;
export const MAX_LOG_EVENTS = 200;

/** Validates what a harness passed to llm() and converts it to a SolverRequest. */
export function normalizeSolverRequest(arg: unknown, maxTokensCap: number): SolverRequest {
	if (typeof arg === "string") return { messages: [{ role: "user", content: nonEmpty(arg) }], maxTokens: maxTokensCap };
	if (arg === null || typeof arg !== "object" || Array.isArray(arg)) {
		throw new TypeError("llm() expects a prompt string or an object {system, prompt, messages, temperature, maxTokens}");
	}
	const r = arg as Record<string, unknown>;
	const raw: SolverMessage[] = [];
	if (r.messages !== undefined) {
		if (!Array.isArray(r.messages)) throw new TypeError("llm(): messages must be an array of {role, content}");
		for (const m of r.messages) {
			const { role, content } = (m ?? {}) as Record<string, unknown>;
			if (role !== "user" && role !== "assistant") {
				throw new TypeError(`llm(): message role must be "user" or "assistant", got ${JSON.stringify(role)}`);
			}
			if (typeof content !== "string") throw new TypeError("llm(): message content must be a string");
			raw.push({ role, content });
		}
	}
	if (r.prompt !== undefined) {
		if (typeof r.prompt !== "string") throw new TypeError("llm(): prompt must be a string");
		raw.push({ role: "user", content: r.prompt });
	}
	if (raw.length === 0) throw new TypeError("llm(): provide prompt or messages");
	const messages = mergeConsecutive(raw);
	if (messages[0].role !== "user") throw new TypeError('llm(): the first message must have role "user"');
	if (messages[messages.length - 1].role !== "user") {
		throw new TypeError('llm(): the last message must have role "user"');
	}
	if (r.system !== undefined && typeof r.system !== "string") throw new TypeError("llm(): system must be a string");
	const request: SolverRequest = { messages, maxTokens: maxTokensCap };
	if (typeof r.system === "string" && r.system.length > 0) request.system = r.system;
	if (typeof r.temperature === "number" && Number.isFinite(r.temperature)) {
		request.temperature = Math.min(Math.max(r.temperature, 0), 1.5);
	}
	if (typeof r.maxTokens === "number" && Number.isFinite(r.maxTokens)) {
		request.maxTokens = Math.max(16, Math.min(Math.floor(r.maxTokens), maxTokensCap));
	}
	return request;
}

function nonEmpty(text: string): string {
	return text.length > 0 ? text : "(empty)";
}

function mergeConsecutive(messages: SolverMessage[]): SolverMessage[] {
	const out: SolverMessage[] = [];
	for (const m of messages) {
		const content = nonEmpty(m.content);
		const last = out[out.length - 1];
		if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
		else out.push({ role: m.role, content });
	}
	return out;
}

function renderRequest(request: SolverRequest): string {
	const parts: string[] = [];
	if (request.system) parts.push(`[system] ${request.system}`);
	for (const m of request.messages) parts.push(`[${m.role}] ${m.content}`);
	return parts.join("\n");
}

function renderPython(result: PythonResult): string {
	const parts = [result.stdout.length ? `stdout:\n${result.stdout}` : "stdout: (empty)"];
	if (result.stderr.length) parts.push(`stderr:\n${result.stderr}`);
	return parts.join("\n");
}

function stringifyLog(values: unknown[]): string {
	return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
}

/** Builds the codemode globals a harness can call for one question. */
export function createGlobals(
	capabilities: readonly CapabilityName[],
	deps: CapabilityDeps,
	budgets: Budgets,
	state: QuestionState,
): CodemodeTool[] {
	const globals: CodemodeTool[] = [];
	const elapsed = () => Date.now() - state.startedAt;
	const charge = (tool: BudgetedTool, limit: number) => {
		if (state.calls[tool] >= limit) {
			state.budgetExceeded = true;
			throw new Error(`${tool}() budget exhausted: at most ${limit} calls per question`);
		}
		state.calls[tool]++;
	};

	if (capabilities.includes("llm")) {
		globals.push({
			name: "llm",
			description: "Call the fixed solver model and return its text output.",
			signature:
				'(request: string | { system?: string; prompt?: string; messages?: { role: "user" | "assistant"; content: string }[]; temperature?: number; maxTokens?: number }): Promise<string>',
			execute: async (arg, { signal }) => {
				const request = normalizeSolverRequest(arg, budgets.maxTokensPerCall);
				charge("llm", budgets.llmCalls);
				const at = elapsed();
				const input = clipMiddle(renderRequest(request), TRACE_CHARS);
				const started = Date.now();
				try {
					const response = await deps.solver.complete(request, signal);
					state.trace.push({
						tool: "llm",
						at,
						durationMs: Date.now() - started,
						input,
						output: clipMiddle(response.text, TRACE_CHARS),
						usage: response.usage,
						...(response.stopReason === "length" ? { error: "output truncated at maxTokens" } : {}),
					});
					return response.text;
				} catch (error) {
					state.trace.push({ tool: "llm", at, durationMs: Date.now() - started, input, output: "", error: errorMessage(error) });
					throw error;
				}
			},
		});
	}

	if (capabilities.includes("python")) {
		const runner = deps.python;
		if (!runner) throw new Error("This task enables python(), but no PythonRunner was configured");
		globals.push({
			name: "python",
			spread: true,
			description: "Run Python 3 code in an isolated subprocess and return its output.",
			signature:
				"(code: string, options?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>",
			execute: async (args, { signal }) => {
				const [code, options] = args as [unknown, unknown];
				if (typeof code !== "string") throw new TypeError("python(code) expects Python source as a string");
				const opts = (options ?? {}) as Record<string, unknown>;
				const timeoutMs =
					typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
						? Math.max(100, Math.min(opts.timeoutMs, budgets.pythonTimeoutMs))
						: budgets.pythonTimeoutMs;
				const stdin = typeof opts.stdin === "string" ? opts.stdin : undefined;
				charge("python", budgets.pythonCalls);
				const at = elapsed();
				const started = Date.now();
				const input = clipMiddle(code, TRACE_CHARS);
				try {
					const result = await runner.run(code, { timeoutMs, stdin, signal });
					const error = result.timedOut
						? `timed out after ${timeoutMs} ms`
						: result.exitCode !== 0
							? `exit code ${result.exitCode}`
							: undefined;
					state.trace.push({
						tool: "python",
						at,
						durationMs: Date.now() - started,
						input,
						output: clipMiddle(renderPython(result), TRACE_CHARS),
						...(error ? { error } : {}),
					});
					return result;
				} catch (error) {
					state.trace.push({ tool: "python", at, durationMs: Date.now() - started, input, output: "", error: errorMessage(error) });
					throw error;
				}
			},
		});
	}

	if (capabilities.includes("search")) {
		const backend = deps.search;
		if (!backend) throw new Error("This task enables search(), but no SearchBackend was configured");
		globals.push({
			name: "search",
			spread: true,
			description: "Retrieve passages from the task corpus.",
			signature: "(query: string, k?: number): Promise<{ id: string; title: string; text: string }[]>",
			execute: async (args) => {
				const [query, k] = args as [unknown, unknown];
				if (typeof query !== "string") throw new TypeError("search(query, k) expects the query as a string");
				const limit =
					typeof k === "number" && Number.isFinite(k) ? Math.max(1, Math.min(Math.floor(k), budgets.searchMaxK)) : 5;
				charge("search", budgets.searchCalls);
				const at = elapsed();
				const started = Date.now();
				try {
					const passages = await backend.search(query, limit);
					state.trace.push({
						tool: "search",
						at,
						durationMs: Date.now() - started,
						input: clipMiddle(`${query} (k=${limit})`, TRACE_CHARS),
						output: clipMiddle(passages.map((p) => p.title).join(" | "), TRACE_CHARS),
					});
					return passages;
				} catch (error) {
					state.trace.push({
						tool: "search",
						at,
						durationMs: Date.now() - started,
						input: query,
						output: "",
						error: errorMessage(error),
					});
					throw error;
				}
			},
		});
	}

	globals.push({
		name: "log",
		spread: true,
		description: "Record a note in the execution trace.",
		signature: "(...values: unknown[]): void",
		execute: (args) => {
			if (state.logEvents < MAX_LOG_EVENTS) {
				state.logEvents++;
				state.trace.push({
					tool: "log",
					at: elapsed(),
					durationMs: 0,
					input: clipMiddle(stringifyLog(args as unknown[]), 2000),
					output: "",
				});
			}
			return null;
		},
	});

	return globals;
}
```

**File: `src/core/sandbox.ts`**
```ts
import { type CodemodeError, type CodemodeOutputItem, CodemodeSandbox } from "@earendil-works/pi-codemode";
import { clipMiddle } from "../util/text.ts";
import { type Budgets, type CapabilityDeps, createGlobals, MAX_LOG_EVENTS, newQuestionState, type QuestionState } from "./capabilities.ts";
import type { BudgetedTool, CapabilityName, TaskInfo, TraceEvent, Usage } from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export type RunErrorKind = "script" | "timeout" | "aborted" | "sandbox" | "budget" | "no-answer";

export interface HarnessRun {
	answer: string | null;
	error?: { kind: RunErrorKind; message: string };
	trace: TraceEvent[];
	durationMs: number;
	calls: Record<BudgetedTool, number>;
	usage: Usage;
}

export interface RunHarnessOptions {
	source: string;
	prompt: string;
	task: TaskInfo;
	capabilities: readonly CapabilityName[];
	deps: CapabilityDeps;
	budgets: Budgets;
	signal?: AbortSignal;
	memoryLimitBytes?: number;
}

const DEFAULT_MEMORY_LIMIT = 256 * 1024 * 1024;

/** Wraps harness source into a codemode script body that calls solve(prompt) and returns a string or null. */
export function buildProgram(source: string, task: TaskInfo, prompt: string): string {
	const taskLiteral = JSON.stringify({ name: task.name, description: task.description });
	return [
		`const TASK = Object.freeze(${taskLiteral});${source}`,
		`;if (typeof solve !== "function") throw new Error("The harness must define async function solve(question).");`,
		`const __answer = await solve(${JSON.stringify(prompt)});`,
		"if (__answer === undefined || __answer === null) return null;",
		'return typeof __answer === "string" ? __answer : JSON.stringify(__answer);',
	].join("\n");
}

/** Runs one harness on one question in a fresh QuickJS VM. Never throws for harness failures. */
export async function runHarness(o: RunHarnessOptions): Promise<HarnessRun> {
	const state = newQuestionState();
	const sandbox = new CodemodeSandbox({
		globals: createGlobals(o.capabilities, o.deps, o.budgets, state),
		timeoutMs: o.budgets.questionTimeoutMs,
		memoryLimitBytes: o.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT,
	});
	try {
		const result = await sandbox.execute(buildProgram(o.source, o.task, o.prompt), { signal: o.signal });
		appendOutput(state, result.output);
		const base = {
			trace: [...state.trace],
			durationMs: Date.now() - state.startedAt,
			calls: { ...state.calls },
			usage: sumUsage(state.trace),
		};
		if (!result.ok) {
			const kind: RunErrorKind = state.budgetExceeded && result.error.kind === "script" ? "budget" : result.error.kind;
			return { ...base, answer: null, error: { kind, message: describeError(result.error) } };
		}
		if (result.value === null || result.value === undefined) {
			return { ...base, answer: null, error: { kind: "no-answer", message: "solve() returned no answer" } };
		}
		return { ...base, answer: String(result.value) };
	} finally {
		await sandbox.close();
	}
}

function describeError(error: CodemodeError): string {
	const head = error.name ? `${error.name}: ${error.message}` : error.message;
	if (!error.stack) return head;
	const frames = error.stack
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("at "))
		.slice(0, 4);
	return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

function appendOutput(state: QuestionState, output: CodemodeOutputItem[]): void {
	const at = Date.now() - state.startedAt;
	for (const item of output) {
		if (item.type !== "text" || state.logEvents >= MAX_LOG_EVENTS) continue;
		state.logEvents++;
		state.trace.push({ tool: "log", at, durationMs: 0, input: clipMiddle(item.text, 2000), output: "" });
	}
}

function sumUsage(trace: readonly TraceEvent[]): Usage {
	const total = emptyUsage();
	for (const event of trace) if (event.usage) addUsage(total, event.usage);
	return total;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/sandbox.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/usage.ts src/core/capabilities.ts src/core/sandbox.ts test/helpers.ts test/sandbox.test.ts
git commit -m "feat: run harnesses in pi-codemode with budgeted, traced capabilities"
git push origin main
```

---

### Task 4: Executor and toy task

**Files:**
- Create: `src/core/executor.ts`, `src/tasks/toy.ts`
- Test: `test/executor.test.ts`

**Interfaces:**
- Consumes: `runHarness`, `Budgets`, `CapabilityDeps`, types from Task 3; `mapLimit`, `hashSource`.
- Produces: `evaluateHarness(options: EvaluateOptions): Promise<EvalResult>`, `classifyOutcome(run, score): OutcomeKind`, `summarizeOutcomes(label, hash, outcomes, durationMs): EvalResult`, `createArithmeticTask(options?): Task` (name `toy:addition`).

- [ ] **Step 1: Write the failing test**

**Test: `test/executor.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import type { Task } from "../src/core/types.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const SEED = `
async function solve(question) {
	const reply = await llm(question);
	return reply.trim();
}`;

describe("evaluateHarness", () => {
	test("scores answers and summarizes outcomes", async () => {
		const task = createArithmeticTask({ dev: 6, heldout: 4, seed: 3 });
		let call = 0;
		const solver = stubSolver((request) => {
			call++;
			const sum = sumInPrompt(request.messages[0].content) ?? 0;
			return String(call % 2 === 0 ? sum : sum + 1);
		});
		const result = await evaluateHarness({
			task,
			source: SEED,
			questions: task.dev,
			label: "dev",
			deps: { solver, python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 1,
		});
		expect(result.outcomes).toHaveLength(6);
		expect(result.mean).toBeCloseTo(0.5);
		expect(result.counts.correct).toBe(3);
		expect(result.counts.wrong).toBe(3);
		expect(result.completedFraction).toBe(1);
		expect(result.calls.llm).toBe(6);
		expect(result.harnessHash).toHaveLength(12);
	});

	test("grader exceptions score zero without failing the evaluation", async () => {
		const base = createArithmeticTask({ dev: 2, heldout: 1 });
		const task: Task = {
			...base,
			grade: async () => {
				throw new Error("scorer crashed");
			},
		};
		const result = await evaluateHarness({
			task,
			source: SEED,
			questions: task.dev,
			label: "dev",
			deps: { solver: stubSolver(() => "1"), python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 2,
		});
		expect(result.mean).toBe(0);
		expect(result.outcomes[0].gradeDetail).toContain("scorer crashed");
		expect(result.outcomes[0].kind).toBe("wrong");
	});

	test("harness errors are counted and lower completedFraction", async () => {
		const task = createArithmeticTask({ dev: 3, heldout: 1 });
		const result = await evaluateHarness({
			task,
			source: `async function solve(q) { if (q.includes("+")) throw new Error("boom"); return "x"; }`,
			questions: task.dev,
			label: "dev",
			deps: { solver: stubSolver(() => "1"), python: stubPython() },
			budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 },
			concurrency: 3,
		});
		expect(result.counts.error).toBe(3);
		expect(result.completedFraction).toBe(0);
		expect(result.outcomes[0].error).toContain("boom");
	});
});

describe("createArithmeticTask", () => {
	test("is deterministic with disjoint ids", () => {
		const a = createArithmeticTask({ dev: 3, heldout: 3, seed: 5 });
		const b = createArithmeticTask({ dev: 3, heldout: 3, seed: 5 });
		expect(a.dev.map((q) => q.prompt)).toEqual(b.dev.map((q) => q.prompt));
		const ids = new Set([...a.dev, ...a.heldout].map((q) => q.id));
		expect(ids.size).toBe(6);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/executor.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/executor.ts`**
```ts
import { mapLimit } from "../util/concurrency.ts";
import { hashSource } from "../util/hash.ts";
import { errorMessage } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { type HarnessRun, runHarness } from "./sandbox.ts";
import {
	type EvalResult,
	OUTCOME_KINDS,
	type OutcomeKind,
	type Question,
	type QuestionOutcome,
	type Task,
} from "./types.ts";
import { addUsage, emptyUsage } from "./usage.ts";

export interface EvaluateOptions {
	task: Task;
	source: string;
	questions: readonly Question[];
	label: string;
	deps: CapabilityDeps;
	budgets: Budgets;
	concurrency: number;
	signal?: AbortSignal;
	onOutcome?: (outcome: QuestionOutcome, done: number, total: number) => void;
}

export function classifyOutcome(run: Pick<HarnessRun, "error">, score: number): OutcomeKind {
	if (run.error) {
		if (run.error.kind === "timeout") return "timeout";
		if (run.error.kind === "budget") return "budget";
		return "error";
	}
	if (score >= 1 - 1e-9) return "correct";
	if (score > 0) return "partial";
	return "wrong";
}

/** J(h; Q): runs the harness on every question and grades the answers. */
export async function evaluateHarness(o: EvaluateOptions): Promise<EvalResult> {
	const started = Date.now();
	const info = { name: o.task.name, description: o.task.description };
	let done = 0;
	const outcomes = await mapLimit(o.questions, o.concurrency, async (question): Promise<QuestionOutcome> => {
		const run = await runHarness({
			source: o.source,
			prompt: question.prompt,
			task: info,
			capabilities: o.task.capabilities,
			deps: o.deps,
			budgets: o.budgets,
			signal: o.signal,
		});
		let score = 0;
		let gradeDetail: string | undefined;
		if (run.answer !== null) {
			try {
				const grade = await o.task.grade(question, run.answer);
				score = Number.isFinite(grade.score) ? Math.min(Math.max(grade.score, 0), 1) : 0;
				gradeDetail = grade.detail;
			} catch (error) {
				gradeDetail = `grader error: ${errorMessage(error)}`;
			}
		}
		const outcome: QuestionOutcome = {
			questionId: question.id,
			answer: run.answer,
			score,
			kind: classifyOutcome(run, score),
			error: run.error?.message,
			gradeDetail,
			trace: run.trace,
			durationMs: run.durationMs,
			calls: run.calls,
			usage: run.usage,
		};
		done++;
		o.onOutcome?.(outcome, done, o.questions.length);
		return outcome;
	});
	return summarizeOutcomes(o.label, hashSource(o.source), outcomes, Date.now() - started);
}

export function summarizeOutcomes(
	label: string,
	harnessHash: string,
	outcomes: QuestionOutcome[],
	durationMs: number,
): EvalResult {
	const counts = Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<OutcomeKind, number>;
	const calls = { llm: 0, python: 0, search: 0 };
	const usage = emptyUsage();
	let total = 0;
	for (const outcome of outcomes) {
		counts[outcome.kind]++;
		total += outcome.score;
		calls.llm += outcome.calls.llm;
		calls.python += outcome.calls.python;
		calls.search += outcome.calls.search;
		addUsage(usage, outcome.usage);
	}
	const n = outcomes.length;
	const completed = n - counts.error - counts.timeout - counts.budget;
	return {
		label,
		harnessHash,
		mean: n ? total / n : 0,
		counts,
		completedFraction: n ? completed / n : 0,
		outcomes,
		calls,
		usage,
		durationMs,
	};
}
```

**File: `src/tasks/toy.ts`**
```ts
import type { Question, Task } from "../core/types.ts";
import { createRng } from "../util/random.ts";

/** Offline task for tests and smoke runs: add two integers. */
export function createArithmeticTask(options: { dev?: number; heldout?: number; seed?: number } = {}): Task {
	const rng = createRng(options.seed ?? 7);
	const make = (split: string, n: number): Question[] =>
		Array.from({ length: n }, (_, i) => {
			const a = 100 + Math.floor(rng() * 9900);
			const b = 100 + Math.floor(rng() * 9900);
			return { id: `addition/${split}/${i}`, prompt: `What is ${a} + ${b}? Reply with the number only.`, answer: String(a + b) };
		});
	return {
		name: "toy:addition",
		description: "Add two integers. The answer is the integer only, with no other text.",
		capabilities: ["llm", "python"],
		dev: make("dev", options.dev ?? 10),
		heldout: make("heldout", options.heldout ?? 10),
		grade: async (question, answer) => ({ score: answer.trim() === question.answer ? 1 : 0 }),
	};
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/executor.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/executor.ts src/tasks/toy.ts test/executor.test.ts
git commit -m "feat: evaluate harnesses on question sets with grading and outcome summaries"
git push origin main
```

---

### Task 5: SEARCH/REPLACE edits

**Files:**
- Create: `src/core/edits.ts`
- Test: `test/edits.test.ts`

**Interfaces:**
- Produces: `EditBlock {search, replace}`, `ParsedProposal` (`edits` | `full` | `no_change` | `unparseable`), `parseEditBlocks(text)`, `parseProposal(text): ParsedProposal`, `applyEdits(source, blocks): ApplyResult` where `ApplyResult = {ok: true, source} | {ok: false, error}`.

- [ ] **Step 1: Write the failing test**

**Test: `test/edits.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { applyEdits, parseEditBlocks, parseProposal } from "../src/core/edits.ts";

const SOURCE = [
	'const SYSTEM = "Answer briefly.";',
	"",
	"async function solve(question) {",
	"\tconst reply = await llm({ system: SYSTEM, prompt: question });",
	"\treturn reply.trim();",
	"}",
	"",
].join("\n");

describe("parseProposal", () => {
	test("parses SEARCH/REPLACE blocks, diagnosis and manifest", () => {
		const text = [
			"## Diagnosis",
			"Answers include reasoning.",
			"## Edits",
			"```js",
			"<<<<<<< SEARCH",
			"\treturn reply.trim();",
			"=======",
			'\treturn reply.split("Answer:").pop().trim();',
			">>>>>>> REPLACE",
			"```",
			"## Change manifest",
			"Extract the final answer.",
		].join("\n");
		const parsed = parseProposal(text);
		expect(parsed.kind).toBe("edits");
		if (parsed.kind !== "edits") return;
		expect(parsed.blocks).toEqual([
			{ search: "\treturn reply.trim();", replace: '\treturn reply.split("Answer:").pop().trim();' },
		]);
		expect(parsed.diagnosis).toBe("Answers include reasoning.");
		expect(parsed.manifest).toBe("Extract the final answer.");
	});

	test("recognizes NO_CHANGE", () => {
		expect(parseProposal("NO_CHANGE: already optimal")).toEqual({ kind: "no_change", reason: "already optimal" });
	});

	test("accepts a full harness code block", () => {
		const parsed = parseProposal('Here is the new harness:\n```javascript\nasync function solve(q) {\n\treturn "1";\n}\n```');
		expect(parsed.kind).toBe("full");
		if (parsed.kind === "full") expect(parsed.source).toBe('async function solve(q) {\n\treturn "1";\n}\n');
	});

	test("reports incomplete blocks and missing edits", () => {
		expect(parseProposal("<<<<<<< SEARCH\nfoo\n=======\nbar").kind).toBe("unparseable");
		expect(parseProposal("I would change the prompt.").kind).toBe("unparseable");
	});

	test("handles CRLF responses", () => {
		const { blocks } = parseEditBlocks("<<<<<<< SEARCH\r\na\r\n=======\r\nb\r\n>>>>>>> REPLACE\r\n");
		expect(blocks).toEqual([{ search: "a", replace: "b" }]);
	});
});

describe("applyEdits", () => {
	test("applies exact edits in order", () => {
		const result = applyEdits(SOURCE, [
			{ search: 'const SYSTEM = "Answer briefly.";', replace: 'const SYSTEM = "Think, then answer.";' },
			{ search: "\treturn reply.trim();", replace: "\treturn reply.trim().toLowerCase();" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source).toContain("Think, then answer.");
			expect(result.source).toContain("toLowerCase");
		}
	});

	test("does not interpret $ patterns in replacements", () => {
		const result = applyEdits(SOURCE, [{ search: "\treturn reply.trim();", replace: '\treturn "$&$1";' }]);
		expect(result.ok && result.source).toContain('return "$&$1";');
	});

	test("tolerates indentation drift when the match is unique", () => {
		const result = applyEdits(SOURCE, [{ search: "  return reply.trim();", replace: "\treturn reply;" }]);
		expect(result.ok && result.source).toContain("\treturn reply;");
	});

	test("rejects ambiguous and missing SEARCH text", () => {
		const ambiguous = applyEdits(`${SOURCE}\n${SOURCE}`, [{ search: "\treturn reply.trim();", replace: "x" }]);
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) expect(ambiguous.error).toContain("2 times");
		const missing = applyEdits(SOURCE, [{ search: "return nothing;", replace: "x" }]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toContain("not found");
	});

	test("an empty SEARCH appends to the end", () => {
		const result = applyEdits(SOURCE, [{ search: "", replace: "function helper() { return 1; }" }]);
		expect(result.ok && result.source.endsWith("function helper() { return 1; }\n")).toBe(true);
	});

	test("normalizes CRLF sources", () => {
		const result = applyEdits("a\r\nb\r\n", [{ search: "b", replace: "c" }]);
		expect(result.ok && result.source).toBe("a\nc\n");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/edits.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/edits.ts`**
```ts
export interface EditBlock {
	search: string;
	replace: string;
}

export type ParsedProposal =
	| { kind: "edits"; blocks: EditBlock[]; diagnosis?: string; manifest?: string }
	| { kind: "full"; source: string; diagnosis?: string; manifest?: string }
	| { kind: "no_change"; reason: string }
	| { kind: "unparseable"; error: string };

export type ApplyResult = { ok: true; source: string } | { ok: false; error: string };

const SEARCH_LINE = /^\s*<{5,9}\s*SEARCH\s*$/;
const DIVIDER_LINE = /^\s*={5,9}\s*$/;
const REPLACE_LINE = /^\s*>{5,9}\s*REPLACE\s*$/;
const NO_CHANGE = /^\s*(?:\*\*)?NO_CHANGE(?:\*\*)?\s*[:\-—]?\s*(.*)$/m;
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const JS_LANGS = new Set(["", "js", "javascript", "mjs", "jsx"]);

/** Extracts SEARCH/REPLACE blocks. Content between markers is kept verbatim. */
export function parseEditBlocks(text: string): { blocks: EditBlock[]; error?: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: EditBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!SEARCH_LINE.test(lines[i])) {
			i++;
			continue;
		}
		const start = i + 1;
		let divider = -1;
		let end = -1;
		for (let j = start; j < lines.length; j++) {
			if (divider < 0 && DIVIDER_LINE.test(lines[j])) {
				divider = j;
				continue;
			}
			if (divider >= 0 && REPLACE_LINE.test(lines[j])) {
				end = j;
				break;
			}
			if (SEARCH_LINE.test(lines[j])) break;
		}
		if (divider < 0 || end < 0) {
			return {
				blocks,
				error: `Edit block ${blocks.length + 1} is incomplete: expected "=======" and ">>>>>>> REPLACE" after "<<<<<<< SEARCH".`,
			};
		}
		blocks.push({ search: lines.slice(start, divider).join("\n"), replace: lines.slice(divider + 1, end).join("\n") });
		i = end + 1;
	}
	return { blocks };
}

/** Parses a proposer's final answer into edits, a full harness, or a no-change declaration. */
export function parseProposal(text: string): ParsedProposal {
	const normalized = text.replace(/\r\n/g, "\n");
	const diagnosis = extractSection(normalized, ["diagnosis"]);
	const manifest = extractSection(normalized, ["change manifest", "manifest"]);
	const { blocks, error } = parseEditBlocks(normalized);
	if (error) return { kind: "unparseable", error };
	if (blocks.length > 0) return { kind: "edits", blocks, diagnosis, manifest };
	const noChange = NO_CHANGE.exec(normalized);
	if (noChange) return { kind: "no_change", reason: noChange[1].trim() || "declared no change" };
	const full = findFullHarness(normalized);
	if (full) return { kind: "full", source: full, diagnosis, manifest };
	return {
		kind: "unparseable",
		error:
			"No edits found. Use SEARCH/REPLACE blocks (<<<<<<< SEARCH / ======= / >>>>>>> REPLACE), a complete harness in one ```js code block, or reply NO_CHANGE: <reason>.",
	};
}

/** Applies blocks in order: exact unique match first, then a unique whitespace-insensitive line match. */
export function applyEdits(source: string, blocks: readonly EditBlock[]): ApplyResult {
	let current = source.replace(/\r\n/g, "\n");
	for (const [index, block] of blocks.entries()) {
		const label = `Edit ${index + 1}`;
		const search = block.search.replace(/\r\n/g, "\n");
		const replace = block.replace.replace(/\r\n/g, "\n");
		if (search.trim() === "") {
			current = `${current.replace(/\n*$/, "\n")}${replace}\n`;
			continue;
		}
		const occurrences = countOccurrences(current, search);
		if (occurrences === 1) {
			current = current.replace(search, () => replace);
			continue;
		}
		if (occurrences > 1) {
			return {
				ok: false,
				error: `${label}: the SEARCH text occurs ${occurrences} times in the current harness. Include more surrounding lines so it matches exactly once.`,
			};
		}
		const loose = replaceLinesLoosely(current, search, replace);
		if (loose.kind === "ok") {
			current = loose.source;
			continue;
		}
		if (loose.kind === "ambiguous") {
			return {
				ok: false,
				error: `${label}: the SEARCH text matches ${loose.count} places when whitespace is ignored. Include more surrounding lines.`,
			};
		}
		const first = search.split("\n").find((line) => line.trim().length > 0) ?? "";
		return {
			ok: false,
			error: `${label}: the SEARCH text was not found in the current harness. SEARCH must copy existing lines exactly. Its first line was ${JSON.stringify(first.trim().slice(0, 120))}.`,
		};
	}
	return { ok: true, source: current };
}

function extractSection(text: string, names: readonly string[]): string | undefined {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const heading = /^#{1,6}\s+(.*)$/.exec(lines[i]);
		if (!heading) continue;
		const title = heading[1].trim().toLowerCase();
		if (!names.some((name) => title.startsWith(name))) continue;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length && !/^#{1,6}\s+/.test(lines[j]); j++) body.push(lines[j]);
		const content = body.join("\n").trim();
		return content.length > 0 ? content : undefined;
	}
	return undefined;
}

function findFullHarness(text: string): string | undefined {
	let best: string | undefined;
	for (const match of text.matchAll(FENCE)) {
		const lang = match[1].trim().split(/\s+/)[0].toLowerCase();
		if (!JS_LANGS.has(lang)) continue;
		const body = match[2];
		if (!/\bfunction\s+solve\s*\(/.test(body)) continue;
		if (!best || body.length > best.length) best = body;
	}
	return best?.replace(/\s+$/, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
	return count;
}

type LooseResult = { kind: "ok"; source: string } | { kind: "ambiguous"; count: number } | { kind: "missing" };

function replaceLinesLoosely(source: string, search: string, replace: string): LooseResult {
	const lines = source.split("\n");
	const needle = trimBlankEdges(search.split("\n"));
	if (needle.length === 0) return { kind: "missing" };
	const normalizers = [(s: string) => s.trimEnd(), (s: string) => s.trim()];
	for (const normalize of normalizers) {
		const target = needle.map(normalize);
		const hits: number[] = [];
		for (let i = 0; i + target.length <= lines.length; i++) {
			let match = true;
			for (let j = 0; j < target.length; j++) {
				if (normalize(lines[i + j]) !== target[j]) {
					match = false;
					break;
				}
			}
			if (match) hits.push(i);
		}
		if (hits.length === 1) {
			const at = hits[0];
			const out = [...lines.slice(0, at), ...replace.split("\n"), ...lines.slice(at + target.length)];
			return { kind: "ok", source: out.join("\n") };
		}
		if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
	}
	return { kind: "missing" };
}

function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/edits.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/edits.ts test/edits.test.ts
git commit -m "feat: parse and apply SEARCH/REPLACE harness edits"
git push origin main
```

---

### Task 6: Static screens

**Files:**
- Create: `src/core/screens.ts`
- Test: `test/screens.test.ts`

**Interfaces:**
- Produces: `ScreenOptions {maxLines, maxChars?, shownQuestions?, shownAnswers?}`, `ScreenResult = {ok: true} | {ok: false, reason}`, `screenHarness(source, options): Promise<ScreenResult>`, `findHardCodedAnswer(source, answers): string | undefined`, `containsQuestionSpecificText(source, questions): boolean`.

- [ ] **Step 1: Write the failing test**

**Test: `test/screens.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { containsQuestionSpecificText, findHardCodedAnswer, screenHarness } from "../src/core/screens.ts";

const OK = "async function solve(question) {\n\treturn await llm(question);\n}\n";

describe("screenHarness", () => {
	test("accepts a valid harness", async () => {
		expect(await screenHarness(OK, { maxLines: 50 })).toEqual({ ok: true });
	});

	test("rejects syntax errors and a missing solve", async () => {
		const syntax = await screenHarness("async function solve( {", { maxLines: 50 });
		expect(syntax.ok).toBe(false);
		if (!syntax.ok) expect(syntax.reason).toContain("failed to load");
		const missing = await screenHarness("function other() {}", { maxLines: 50 });
		expect(missing).toEqual({ ok: false, reason: "The harness must define async function solve(question)." });
	});

	test("rejects harnesses over the line limit", async () => {
		const result = await screenHarness(`${"// filler\n".repeat(60)}${OK}`, { maxLines: 50 });
		expect(result.ok).toBe(false);
	});

	test("rejects top-level calls to capabilities", async () => {
		const result = await screenHarness(`const x = await llm("hi");\n${OK}`, { maxLines: 50 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("not available");
	});

	test("rejects hard-coded instance answers", async () => {
		const answer = "THOSE FROM MARS OF ANY INDEED";
		const result = await screenHarness(`${OK}const KNOWN = "${answer}";\n`, {
			maxLines: 50,
			shownAnswers: [answer, "8"],
		});
		expect(result.ok).toBe(false);
	});
});

describe("hard-coding detectors", () => {
	test("short or generic answers are not flagged", () => {
		expect(findHardCodedAnswer('const words = ["mother-in-law", "8"];', ["mother-in-law", "8"])).toBeUndefined();
		expect(findHardCodedAnswer('x = "6 7 8 1 9 2 4 3 5"', ["6 7 8 1 9 2 4 3 5"])).toBe("6 7 8 1 9 2 4 3 5");
	});

	test("template text shared by questions is allowed; instance text is not", () => {
		const template = "Navigate from the start to the goal in the following maze. ";
		const q1 = `${template}Grid A: ###..##..#..###...##...#.#.#.##..##`;
		const q2 = `${template}Grid B: #.#.#.#.###...###...#..#..##.#.#.##.`;
		expect(containsQuestionSpecificText(`const P = "${template}";`, [q1, q2])).toBe(false);
		expect(containsQuestionSpecificText(`const P = "${q1}";`, [q1, q2])).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/screens.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/screens.ts`**
```ts
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { clip } from "../util/text.ts";

export interface ScreenOptions {
	maxLines: number;
	maxChars?: number;
	/** Development question texts that have appeared in reports shown to the proposer. */
	shownQuestions?: readonly string[];
	/** Expected answers that have appeared in reports shown to the proposer. */
	shownAnswers?: readonly string[];
}

export type ScreenResult = { ok: true } | { ok: false; reason: string };

const WINDOW = 48;
const STRIDE = 16;
const DEFAULT_MAX_CHARS = 60_000;

/** Static rejection before a candidate harness is executed (paper App. B.2 screens). */
export async function screenHarness(source: string, o: ScreenOptions): Promise<ScreenResult> {
	const maxChars = o.maxChars ?? DEFAULT_MAX_CHARS;
	if (source.length > maxChars) {
		return { ok: false, reason: `The harness has ${source.length} characters; the limit is ${maxChars}.` };
	}
	const lines = source.split("\n").length;
	if (lines > o.maxLines) {
		return { ok: false, reason: `The harness has ${lines} lines; the limit is ${o.maxLines}. Make it shorter.` };
	}
	const answer = findHardCodedAnswer(source, o.shownAnswers ?? []);
	if (answer !== undefined) {
		return {
			ok: false,
			reason: `The harness contains the expected answer ${JSON.stringify(clip(answer, 80))} of a development question. Do not hard-code answers: the harness is evaluated on unseen questions.`,
		};
	}
	if (containsQuestionSpecificText(source, o.shownQuestions ?? [])) {
		return {
			ok: false,
			reason:
				"The harness contains text copied from a specific development question. Do not special-case development questions: the harness is evaluated on unseen questions.",
		};
	}
	return await checkLoads(source);
}

/** Flags answers that are instance-specific (long, or containing digits or spaces) and appear verbatim. */
export function findHardCodedAnswer(source: string, answers: readonly string[]): string | undefined {
	for (const raw of answers) {
		const answer = raw.trim();
		const instanceSpecific = answer.length >= 24 || (answer.length >= 12 && /[\d\s]/.test(answer));
		if (instanceSpecific && source.includes(answer)) return answer;
	}
	return undefined;
}

/** True when the source contains a window of a question's text that no other shown question shares. */
export function containsQuestionSpecificText(source: string, questions: readonly string[]): boolean {
	for (let qi = 0; qi < questions.length; qi++) {
		const question = questions[qi];
		if (question.length < WINDOW) continue;
		for (let start = 0; start + WINDOW <= question.length; start += STRIDE) {
			const window = question.slice(start, start + WINDOW);
			if (!source.includes(window)) continue;
			const shared = questions.some((other, oi) => oi !== qi && other.includes(window));
			if (!shared) return true;
		}
	}
	return false;
}

async function checkLoads(source: string): Promise<ScreenResult> {
	const stub = (name: string): CodemodeTool => ({
		name,
		spread: true,
		execute: () => {
			throw new Error(`${name}() is not available while the harness is being validated`);
		},
	});
	const sandbox = new CodemodeSandbox({
		globals: [stub("llm"), stub("python"), stub("search"), stub("log")],
		timeoutMs: 5000,
		memoryLimitBytes: 128 * 1024 * 1024,
	});
	try {
		const program = `const TASK = Object.freeze({ name: "validation", description: "" });${source}\n;return typeof solve;`;
		const result = await sandbox.execute(program);
		if (!result.ok) {
			const name = result.error.name ? `${result.error.name}: ` : "";
			return { ok: false, reason: `The harness failed to load: ${name}${result.error.message}` };
		}
		if (result.value !== "function") return { ok: false, reason: "The harness must define async function solve(question)." };
		return { ok: true };
	} finally {
		await sandbox.close();
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/screens.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/screens.ts test/screens.test.ts
git commit -m "feat: static screens for candidate harnesses"
git push origin main
```

---

### Task 7: Execution report

**Files:**
- Create: `src/core/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `EvalResult`, `QuestionOutcome`, `Task`, `Question` (Task 3); `summarizeOutcomes` (Task 4, tests only).
- Produces: `RevisionStatus`, `RevisionRecord {round, candidate, status, score, parentScore, summary}`, `ReportOptions`, `buildReport(options): string`, `pickDiverse(outcomes, n)`, `unifiedDiff(before, after)`.

- [ ] **Step 1: Write the failing test**

**Test: `test/report.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { summarizeOutcomes } from "../src/core/executor.ts";
import { buildReport, pickDiverse, unifiedDiff } from "../src/core/report.ts";
import type { QuestionOutcome } from "../src/core/types.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";

function outcome(
	questionId: string,
	kind: QuestionOutcome["kind"],
	answer: string | null,
	extra: Partial<QuestionOutcome> = {},
): QuestionOutcome {
	return {
		questionId,
		answer,
		score: kind === "correct" ? 1 : 0,
		kind,
		trace: [],
		durationMs: 1200,
		calls: { llm: 1, python: 0, search: 0 },
		usage: { input: 10, output: 5, cost: 0 },
		...extra,
	};
}

describe("buildReport", () => {
	const task = createArithmeticTask({ dev: 4, heldout: 2, seed: 9 });
	const [q0, q1, q2, q3] = task.dev;
	const result = summarizeOutcomes(
		"dev",
		"abc",
		[
			outcome(q0.id, "wrong", "1", {
				trace: [
					{
						tool: "llm",
						at: 0,
						durationMs: 900,
						input: "[user] long prompt",
						output: "the reply",
						usage: { input: 50, output: 20, cost: 0 },
					},
				],
			}),
			outcome(q1.id, "error", null, { error: "TypeError: x is undefined" }),
			outcome(q2.id, "correct", q2.answer),
			outcome(q3.id, "correct", q3.answer),
		],
		5000,
	);
	const report = buildReport({
		task,
		result,
		questions: task.dev,
		currentSource: "b\n",
		previousSource: "a\n",
		history: [{ round: 1, candidate: 0, status: "rejected", score: 0.25, parentScore: 0.5, summary: "Tried | majority vote" }],
	});

	test("summarizes scores and outcome counts", () => {
		expect(report).toContain("Score 0.500 on 4 questions");
		expect(report).toContain("correct 2");
		expect(report).toContain("error 1");
	});

	test("shows failures with question, expected answer, harness answer, trace and error", () => {
		expect(report).toContain(q0.prompt);
		expect(report).toContain(`Expected answer: "${q0.answer}"`);
		expect(report).toContain('Harness answer: "1"');
		expect(report).toContain("the reply");
		expect(report).toContain("TypeError: x is undefined");
	});

	test("includes passing examples, the diff and the revision history", () => {
		expect(report).toContain("## Passing examples");
		expect(report).toContain("-a");
		expect(report).toContain("+b");
		expect(report).toContain("Tried \\| majority vote");
	});

	test("never includes held-out questions", () => {
		for (const q of task.heldout) expect(report).not.toContain(q.prompt);
	});
});

describe("pickDiverse", () => {
	test("round-robins across failure kinds", () => {
		const picked = pickDiverse(
			[outcome("a", "wrong", "x"), outcome("b", "wrong", "x"), outcome("c", "error", null), outcome("d", "timeout", null)],
			3,
		);
		expect(picked.map((o) => o.questionId)).toEqual(["c", "d", "a"]);
	});
});

describe("unifiedDiff", () => {
	test("produces a unified diff without index headers", () => {
		const diff = unifiedDiff("a\nb\n", "a\nc\n");
		expect(diff).toContain("-b");
		expect(diff).toContain("+c");
		expect(diff).not.toContain("Index:");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/report.ts`**
```ts
import { createTwoFilesPatch } from "diff";
import { clip, clipMiddle, fmt } from "../util/text.ts";
import {
	type EvalResult,
	OUTCOME_KINDS,
	type OutcomeKind,
	type Question,
	type QuestionOutcome,
	type Task,
	type TraceEvent,
} from "./types.ts";

export type RevisionStatus = "accepted" | "rejected" | "invalid" | "no_change";

export interface RevisionRecord {
	round: number;
	candidate: number;
	status: RevisionStatus;
	score: number | null;
	parentScore: number | null;
	summary: string;
}

export interface ReportOptions {
	task: Task;
	/** Feedback evaluation of the current harness. Must come from development questions only. */
	result: EvalResult;
	questions: readonly Question[];
	currentSource: string;
	previousSource?: string;
	history: readonly RevisionRecord[];
	maxFailures?: number;
	maxPasses?: number;
	questionChars?: number;
	eventChars?: number;
	maxEvents?: number;
	maxHistory?: number;
}

interface Settings {
	maxFailures: number;
	maxPasses: number;
	questionChars: number;
	eventChars: number;
	maxEvents: number;
	maxHistory: number;
}

const FAILURE_ORDER: readonly OutcomeKind[] = ["error", "timeout", "budget", "wrong", "partial"];

/** Execution report (paper App. E.2): scores, outcomes, failure traces, changes, revision history. */
export function buildReport(o: ReportOptions): string {
	const settings: Settings = {
		maxFailures: o.maxFailures ?? 8,
		maxPasses: o.maxPasses ?? 2,
		questionChars: o.questionChars ?? 1500,
		eventChars: o.eventChars ?? 700,
		maxEvents: o.maxEvents ?? 6,
		maxHistory: o.maxHistory ?? 20,
	};
	const byId = new Map(o.questions.map((q) => [q.id, q]));
	const r = o.result;
	const n = Math.max(r.outcomes.length, 1);
	const avgSeconds = r.outcomes.reduce((sum, x) => sum + x.durationMs, 0) / n / 1000;
	const counts = OUTCOME_KINDS.map((kind) => `${kind} ${r.counts[kind]}`).join(", ");
	const sections = [
		[
			"## Development results",
			`Score ${fmt(r.mean)} on ${r.outcomes.length} questions (${counts}).`,
			`Per question on average: ${fmt(r.calls.llm / n, 1)} solver calls, ${fmt(r.calls.python / n, 1)} python calls, ${fmt(r.calls.search / n, 1)} searches, ${fmt(avgSeconds, 1)} s.`,
		].join("\n"),
	];
	const failures = r.outcomes.filter((x) => x.kind !== "correct");
	const shown = pickDiverse(failures, settings.maxFailures);
	if (shown.length === 0) {
		sections.push("## Failed examples\nNone: every development question was answered correctly.");
	} else {
		sections.push(`## Failed examples (${shown.length} of ${failures.length})`);
		shown.forEach((x, i) => {
			sections.push(renderExample(`Failure ${i + 1}`, x, byId.get(x.questionId), o.task, settings, true));
		});
	}
	const passes = r.outcomes.filter((x) => x.kind === "correct").slice(0, settings.maxPasses);
	if (passes.length > 0) {
		sections.push(`## Passing examples (${passes.length} of ${r.counts.correct})`);
		passes.forEach((x, i) => {
			sections.push(renderExample(`Pass ${i + 1}`, x, byId.get(x.questionId), o.task, settings, false));
		});
	}
	if (o.previousSource !== undefined && o.previousSource !== o.currentSource) {
		sections.push(
			`## Changes since the previous retained harness\n\`\`\`diff\n${unifiedDiff(o.previousSource, o.currentSource)}\n\`\`\``,
		);
	}
	if (o.history.length > 0) sections.push(renderHistory(o.history.slice(-settings.maxHistory)));
	return sections.join("\n\n");
}

/** Up to n outcomes, round-robin over failure kinds so rare kinds are represented. */
export function pickDiverse(outcomes: readonly QuestionOutcome[], n: number): QuestionOutcome[] {
	const queues = FAILURE_ORDER.map((kind) => outcomes.filter((o) => o.kind === kind)).filter((q) => q.length > 0);
	const picked: QuestionOutcome[] = [];
	while (picked.length < n && queues.some((q) => q.length > 0)) {
		for (const queue of queues) {
			const next = queue.shift();
			if (next && picked.length < n) picked.push(next);
		}
	}
	return picked;
}

export function unifiedDiff(before: string, after: string): string {
	const patch = createTwoFilesPatch("previous/harness.js", "current/harness.js", before, after, "", "", { context: 3 });
	return patch
		.split("\n")
		.filter((line) => !line.startsWith("Index:") && !/^=+$/.test(line))
		.join("\n")
		.trim();
}

function renderExample(
	title: string,
	outcome: QuestionOutcome,
	question: Question | undefined,
	task: Task,
	settings: Settings,
	withTrace: boolean,
): string {
	const lines = [`### ${title}: ${outcome.kind}, score ${fmt(outcome.score)} (id ${outcome.questionId})`];
	if (question) {
		lines.push("Question:", "```", clipMiddle(question.prompt, settings.questionChars), "```");
		lines.push(`Expected answer: ${JSON.stringify(clip(question.answer, 500))}`);
	}
	lines.push(`Harness answer: ${outcome.answer === null ? "(none)" : JSON.stringify(clip(outcome.answer, 500))}`);
	if (outcome.gradeDetail) lines.push(`Grader: ${clip(outcome.gradeDetail, 300)}`);
	if (outcome.error) lines.push(`Error: ${clip(outcome.error, 800)}`);
	const extra = question ? task.describeOutcome?.(question, outcome) : undefined;
	if (extra) lines.push(extra);
	if (withTrace && outcome.trace.length > 0) {
		lines.push(`Trace (${outcome.trace.length} events, ${fmt(outcome.durationMs / 1000, 1)} s):`);
		lines.push(renderTrace(outcome.trace, settings));
	}
	return lines.join("\n");
}

function renderTrace(trace: readonly TraceEvent[], settings: Settings): string {
	const indices =
		trace.length <= settings.maxEvents
			? trace.map((_, i) => i)
			: [
					...Array.from({ length: Math.ceil(settings.maxEvents / 2) }, (_, i) => i),
					...Array.from({ length: Math.floor(settings.maxEvents / 2) }, (_, i) => trace.length - Math.floor(settings.maxEvents / 2) + i),
				];
	const out: string[] = [];
	let previous = -1;
	for (const i of indices) {
		if (previous >= 0 && i > previous + 1) out.push(`- … ${i - previous - 1} events omitted …`);
		out.push(renderEvent(i, trace[i], settings.eventChars));
		previous = i;
	}
	return out.join("\n");
}

function renderEvent(index: number, event: TraceEvent, chars: number): string {
	const tokens = event.usage ? `, ${event.usage.input}→${event.usage.output} tokens` : "";
	const head = `- #${index + 1} ${event.tool} (${fmt(event.durationMs / 1000, 1)} s${tokens})${event.error ? ` [${event.error}]` : ""}`;
	const lines = [head, `  input: ${indent(clipMiddle(event.input, chars))}`];
	if (event.output) lines.push(`  output: ${indent(clipMiddle(event.output, chars))}`);
	return lines.join("\n");
}

function indent(text: string): string {
	return text.replace(/\n/g, "\n    ");
}

function renderHistory(history: readonly RevisionRecord[]): string {
	const rows = history.map((h) => {
		const score = h.score === null ? "–" : fmt(h.score);
		const parent = h.parentScore === null ? "–" : fmt(h.parentScore);
		const summary = clip(h.summary.replace(/\s+/g, " "), 240).replace(/\|/g, "\\|");
		return `| ${h.round} | ${h.candidate} | ${h.status} | ${score} | ${parent} | ${summary} |`;
	});
	return [
		"## Revision history",
		"| Round | Candidate | Status | Score | Parent score | Change |",
		"|---|---|---|---|---|---|",
		...rows,
	].join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/report.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/report.ts test/report.test.ts
git commit -m "feat: execution reports with failure traces, diffs and revision history"
git push origin main
```

---

### Task 8: Revision prompts and proposer

**Files:**
- Create: `src/core/prompts.ts`, `src/core/proposer.ts`
- Test: `test/proposer.test.ts`

**Interfaces:**
- Consumes: `applyEdits`, `parseProposal` (Task 5); `ScreenResult` (Task 6); `Budgets` (Task 3); `ProposerClient`.
- Produces: `harnessApiDoc(capabilities, budgets)`, `proposerSystemPrompt({capabilities, budgets, maxLines})`, `revisionPrompt({task, source, score, feedbackSize, report, branch?})`, `retryPrompt(error)`; `ProposalStatus = "edit" | "no_change" | "invalid"`, `Proposal`, `ProposeOptions`, `propose(options): Promise<Proposal>`.

- [ ] **Step 1: Write the failing test**

**Test: `test/proposer.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { propose } from "../src/core/proposer.ts";
import { screenHarness } from "../src/core/screens.ts";
import type { CapabilityName } from "../src/core/types.ts";
import { stubProposer } from "./helpers.ts";

const PARENT = "async function solve(question) {\n\treturn await llm(question);\n}\n";
const capabilities: CapabilityName[] = ["llm", "python"];
const base = {
	task: { name: "toy:addition", description: "Add two integers." },
	capabilities,
	budgets: DEFAULT_BUDGETS,
	parentSource: PARENT,
	parentScore: 0.4,
	feedbackSize: 10,
	report: "## Development results\nScore 0.400 on 10 questions.",
	maxLines: 100,
	attempts: 3,
	screen: (source: string) => screenHarness(source, { maxLines: 100 }),
};
const EDIT = [
	"## Diagnosis",
	"No answer extraction.",
	"## Edits",
	"<<<<<<< SEARCH",
	"\treturn await llm(question);",
	"=======",
	"\tconst reply = await llm(question);",
	"\treturn reply.trim();",
	">>>>>>> REPLACE",
	"## Change manifest",
	"Trim the reply.",
].join("\n");

describe("propose", () => {
	test("returns an applied, screened edit", async () => {
		const client = stubProposer(() => EDIT);
		const proposal = await propose({ ...base, client });
		expect(proposal.status).toBe("edit");
		expect(proposal.source).toContain("reply.trim()");
		expect(proposal.manifest).toBe("Trim the reply.");
		expect(proposal.attempts).toBe(1);
		expect(client.requests[0].system).toContain("async function solve(question)");
		expect(client.requests[0].messages[0].content).toContain("Score 0.400 on 10 questions.");
		expect(client.requests[0].messages[0].content).toContain(PARENT.trim());
	});

	test("retries with error feedback after an edit that does not apply", async () => {
		const client = stubProposer((_, call) =>
			call === 1 ? "<<<<<<< SEARCH\nnot in file\n=======\nx\n>>>>>>> REPLACE" : EDIT,
		);
		const proposal = await propose({ ...base, client });
		expect(proposal.status).toBe("edit");
		expect(proposal.attempts).toBe(2);
		expect(proposal.errors[0]).toContain("not found");
		const retry = client.requests[1].messages;
		expect(retry).toHaveLength(3);
		expect(retry[2].content).toContain("not found");
	});

	test("gives up after the attempt budget", async () => {
		const client = stubProposer(() => "I am not sure.");
		const proposal = await propose({ ...base, client, attempts: 2 });
		expect(proposal.status).toBe("invalid");
		expect(proposal.attempts).toBe(2);
		expect(proposal.parsed).toBe(false);
	});

	test("rejects edits that fail screening", async () => {
		const bad = "<<<<<<< SEARCH\n\treturn await llm(question);\n=======\n\treturn await llm(question;\n>>>>>>> REPLACE";
		const proposal = await propose({ ...base, client: stubProposer(() => bad), attempts: 1 });
		expect(proposal.status).toBe("invalid");
		expect(proposal.parsed).toBe(true);
		expect(proposal.reason).toContain("failed to load");
	});

	test("declared and effective no-change", async () => {
		const declared = await propose({ ...base, client: stubProposer(() => "NO_CHANGE: fine as is") });
		expect(declared.status).toBe("no_change");
		expect(declared.reason).toBe("fine as is");
		const same = await propose({
			...base,
			client: stubProposer(
				() => "<<<<<<< SEARCH\n\treturn await llm(question);\n=======\n\treturn await llm(question);\n>>>>>>> REPLACE",
			),
		});
		expect(same.status).toBe("no_change");
	});

	test("adds a branch instruction for parallel proposals", async () => {
		const client = stubProposer(() => EDIT);
		await propose({ ...base, client, branch: { index: 2, total: 8 } });
		expect(client.requests[0].messages[0].content).toContain("proposal 3 of 8");
	});

	test("counts model errors as attempts", async () => {
		let call = 0;
		const proposal = await propose({
			...base,
			attempts: 2,
			client: {
				async complete() {
					call++;
					return call === 1
						? { text: "", stopReason: "error", usage: { input: 0, output: 0, cost: 0 }, error: "ThrottlingException" }
						: { text: EDIT, stopReason: "stop", usage: { input: 1, output: 1, cost: 0 } };
				},
			},
		});
		expect(proposal.status).toBe("edit");
		expect(proposal.errors[0]).toContain("ThrottlingException");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proposer.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/prompts.ts`**
```ts
import type { Budgets } from "./capabilities.ts";
import type { CapabilityName, TaskInfo } from "./types.ts";

/** Documentation of the harness runtime shown to proposers. */
export function harnessApiDoc(capabilities: readonly CapabilityName[], budgets: Budgets): string {
	const lines = [
		"Harness API. The harness is plain JavaScript (ES2023) that runs in a sandbox. It must define `async function solve(question)` that returns the final answer as a string. These globals are its only I/O:",
		"- `TASK`: frozen object {name, description}.",
	];
	if (capabilities.includes("llm")) {
		lines.push(
			`- \`await llm(request)\` returns a string. \`request\` is a prompt string or {system?, prompt?, messages?: [{role: "user" | "assistant", content}], temperature? (0 to 1.5), maxTokens? (at most ${budgets.maxTokensPerCall})}. It calls the fixed solver model and returns its text. A conversation must start and end with a user message. Budget: ${budgets.llmCalls} calls per question.`,
		);
	}
	if (capabilities.includes("python")) {
		lines.push(
			`- \`await python(code, {timeoutMs?, stdin?})\` returns {stdout, stderr, exitCode, timedOut}. It runs Python 3.12 (standard library, numpy, sympy) in an isolated process with no network and no file access outside a scratch directory. Print results to stdout. Budget: ${budgets.pythonCalls} calls per question, at most ${budgets.pythonTimeoutMs} ms each.`,
		);
	}
	if (capabilities.includes("search")) {
		lines.push(
			`- \`await search(query, k = 5)\` returns [{id, title, text}] by BM25 retrieval over the task corpus (k at most ${budgets.searchMaxK}). Budget: ${budgets.searchCalls} calls per question.`,
		);
	}
	lines.push(
		"- `log(...values)` records a note in the execution trace shown in later reports. `console.log` also records notes.",
		`Each question runs in a fresh sandbox with a ${Math.round(budgets.questionTimeoutMs / 1000)} s limit that includes all calls. Independent calls can run concurrently with Promise.all. There is no require or import, fetch, filesystem, process, or timers, and no state persists between questions.`,
	);
	return lines.join("\n");
}

export function proposerSystemPrompt(o: {
	capabilities: readonly CapabilityName[];
	budgets: Budgets;
	maxLines: number;
}): string {
	return `You are an expert harness engineer. A harness is a JavaScript program that answers the questions of one task by organizing calls to a fixed solver language model, tool use, and direct computation. You cannot change the solver model. You can change everything around it: prompts, the number and order of solver calls, answer parsing and normalization, verification and retries, voting, code execution, retrieval, and direct algorithmic computation in JavaScript.

You receive the task description, the current harness with its development score, and an execution report from running it on development questions. Diagnose the observed failures, then make a targeted revision that should raise the score on new, unseen questions of the same task.

Rules:
- Keep the entry point \`async function solve(question)\`. It must return the final answer as a string in exactly the format the task expects.
- Do not hard-code answers or special-case particular development questions. The revised harness is evaluated on unseen questions.
- Stay within the per-question budgets. Calls beyond a budget throw an error.
- Keep the harness under ${o.maxLines} lines.

${harnessApiDoc(o.capabilities, o.budgets)}

Respond in this format:
## Diagnosis
What fails and why, citing the report.
## Edits
One or more SEARCH/REPLACE blocks against the current harness:
<<<<<<< SEARCH
exact lines copied from the current harness
=======
replacement lines
>>>>>>> REPLACE
SEARCH text must match the current harness exactly, including indentation, and occur once. An empty SEARCH section appends to the end of the file. For a complete rewrite, put the whole new harness in a single \`\`\`js code block instead of SEARCH/REPLACE blocks.
## Change manifest
One paragraph: what changed, which failures it should fix, and likely regressions.

If no change would help, reply with a single line \`NO_CHANGE: <reason>\` instead.`;
}

export function revisionPrompt(o: {
	task: TaskInfo;
	source: string;
	score: number;
	feedbackSize: number;
	report: string;
	branch?: { index: number; total: number };
}): string {
	const parts = [
		`# Task\nName: ${o.task.name}\n${o.task.description}`,
		`# Current harness (development score ${o.score.toFixed(3)} on ${o.feedbackSize} questions)\n\`\`\`js\n${o.source.replace(/\n$/, "")}\n\`\`\``,
		`# Execution report\n${o.report}`,
	];
	if (o.branch) {
		parts.push(
			`# Branch\nYou are proposal ${o.branch.index + 1} of ${o.branch.total} sampled independently from this same report. To keep proposals diverse, rank the promising changes yourself and pursue option number ${o.branch.index + 1}, or a distinct variation if you see fewer options.`,
		);
	}
	parts.push(
		"Propose a targeted revision as SEARCH/REPLACE edits against the current source. Explain the change and identify the failures it is expected to fix and any likely regressions.",
	);
	return parts.join("\n\n");
}

export function retryPrompt(error: string): string {
	return `Your previous response could not be used: ${error}\nThe current harness is unchanged. Reply again in the required format, with SEARCH text copied exactly from the current harness shown above.`;
}
```

**File: `src/core/proposer.ts`**
```ts
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
			const applied = parsed.kind === "full" ? { ok: true as const, source: parsed.source } : applyEdits(parent, parsed.blocks);
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
					return finish("edit", attempt, { source: applied.source, diagnosis: parsed.diagnosis, manifest: parsed.manifest });
				}
				failure = screened.reason;
			}
		}
		errors.push(failure);
		if (attempt < o.attempts) messages.push({ role: "user", content: retryPrompt(failure) });
	}
	return finish("invalid", o.attempts, { reason: errors[errors.length - 1] ?? "no usable response" });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/proposer.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/prompts.ts src/core/proposer.ts test/proposer.test.ts
git commit -m "feat: proposer with revision prompts, edit application, screening and retries"
git push origin main
```

---

### Task 9: Selection protocols and rewards

**Files:**
- Create: `src/core/select.ts`, `src/core/reward.ts`
- Test: `test/select.test.ts`

**Interfaces:**
- Consumes: `ProposalStatus` (Task 8).
- Produces: `SelectionProtocol = "greedy" | "best-of-g"`, `ScoredCandidate {index, status, source, score, completedFraction}`, `Selection {source, score, chosen, reason}`, `selectNext(protocol, parent, candidates)`; `rgReward({parsed, applied, completedFraction, score})`, `qaReward({valid, score})`, `groupAdvantages(rewards, delta?)`.

- [ ] **Step 1: Write the failing test**

**Test: `test/select.test.ts`**
```ts
import { describe, expect, test } from "vitest";
import { groupAdvantages, qaReward, rgReward } from "../src/core/reward.ts";
import { type ScoredCandidate, selectNext } from "../src/core/select.ts";

const parent = { source: "P", score: 0.5 };
const c = (index: number, status: ScoredCandidate["status"], score: number | null, completedFraction = 1): ScoredCandidate => ({
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
		expect(selectNext("best-of-g", parent, [c(0, "edit", 0.3), c(1, "edit", 0.4), c(2, "invalid", null)])).toMatchObject({
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/select.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/select.ts`**
```ts
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
			if (c.status === "edit" && (c.score as number) > parent.score && (!best || (c.score as number) > (best.score as number))) {
				best = c;
			}
		}
		if (!best) return { source: parent.source, score: parent.score, chosen: null, reason: "no candidate improved on the parent" };
		return {
			source: best.source as string,
			score: best.score as number,
			chosen: best.index,
			reason: `candidate ${best.index} improved ${fmt(parent.score)} -> ${fmt(best.score as number)}`,
		};
	}
	const runnable = usable.filter((c) => c.status === "no_change" || c.completedFraction > 0);
	if (runnable.length === 0) {
		return { source: parent.source, score: parent.score, chosen: null, reason: "every candidate failed to parse or run" };
	}
	let best = runnable[0];
	for (const c of runnable) if ((c.score as number) > (best.score as number)) best = c;
	if (best.status === "no_change") {
		return { source: parent.source, score: best.score as number, chosen: null, reason: `no-change proposal ${best.index} scored highest` };
	}
	return {
		source: best.source as string,
		score: best.score as number,
		chosen: best.index,
		reason: `advanced to candidate ${best.index} (${fmt(best.score as number)}; parent ${fmt(parent.score)})`,
	};
}
```

**File: `src/core/reward.ts`**
```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/select.test.ts && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/select.ts src/core/reward.ts test/select.test.ts
git commit -m "feat: greedy and best-of-G selection; Eq. 8/11 rewards and GRPO advantages"
git push origin main
```

---

### Task 10: Run store, adaptation loop, independent single-step revisions

**Files:**
- Create: `src/core/store.ts`, `src/core/loop.ts`, `src/core/independent.ts`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces: `RunStore` (`writeText`, `writeJson`, `readJson`, `writeEval`); `AdaptConfig`, `ProtocolPreset`, `REASONING_GYM_PROTOCOL`, `QA_PROTOCOL`, `AdaptDeps {solver, proposer, python?}`, `AdaptParams`, `RoundSummary`, `AdaptSummary`, `RoleUsage`, `drawRoundSets(dev, config, rng)`, `adapt(params): Promise<AdaptSummary>`; `IndependentConfig`, `IndependentParams`, `IndependentSummary`, `independentRevisions(params): Promise<IndependentSummary>`.

- [ ] **Step 1: Write the failing test**

**Test: `test/loop.test.ts`**
```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { independentRevisions } from "../src/core/independent.ts";
import { type AdaptConfig, adapt, drawRoundSets, QA_PROTOCOL, REASONING_GYM_PROTOCOL } from "../src/core/loop.ts";
import { createArithmeticTask } from "../src/tasks/toy.ts";
import { createRng } from "../src/util/random.ts";
import { stubProposer, stubPython, stubSolver, sumInPrompt } from "./helpers.ts";

const SEED = "async function solve(question) {\n\tconst reply = await llm(question);\n\treturn reply.trim();\n}\n";
const IMPROVE = [
	"## Diagnosis",
	"The solver is sloppy without instructions.",
	"## Edits",
	"<<<<<<< SEARCH",
	"\tconst reply = await llm(question);",
	"=======",
	'\tconst reply = await llm({ system: "CAREFUL", prompt: question });',
	">>>>>>> REPLACE",
	"## Change manifest",
	"Ask for care.",
].join("\n");
const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };

/** Answers correctly only when the system prompt is CAREFUL. */
const solver = () =>
	stubSolver((request) => {
		const sum = sumInPrompt(request.messages[0].content) ?? 0;
		return String(request.system === "CAREFUL" ? sum : sum + 1);
	});

function config(overrides: Partial<AdaptConfig> = {}): AdaptConfig {
	return { ...REASONING_GYM_PROTOCOL, rounds: 2, budgets, concurrency: 4, seed: 1, ...overrides };
}

describe("adapt", () => {
	test("retains an improving revision and reports held-out scores per round", async () => {
		const task = createArithmeticTask({ dev: 6, heldout: 5, seed: 11 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer((_, call) => (call === 1 ? IMPROVE : "NO_CHANGE: done"));
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config(),
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		expect(summary.seedHeldout).toBe(0);
		expect(summary.rounds[0].selection.chosen).toBe(0);
		expect(summary.rounds[0].heldout).toBe(1);
		expect(summary.rounds[1].candidates[0].status).toBe("no_change");
		expect(summary.finalHeldout).toBe(1);
		expect(summary.usage.proposer.calls).toBe(2);
		expect(await readFile(join(runDir, "final.js"), "utf8")).toContain("CAREFUL");
		const round1 = JSON.parse(await readFile(join(runDir, "round-01", "round.json"), "utf8"));
		expect(round1.candidates[0].score).toBe(1);
		const report2 = await readFile(join(runDir, "round-02", "report.md"), "utf8");
		expect(report2).toContain("Revision history");
		expect(report2).toContain('+\tconst reply = await llm({ system: "CAREFUL", prompt: question });');
	});

	test("never shows held-out questions to the proposer", async () => {
		const task = createArithmeticTask({ dev: 5, heldout: 5, seed: 12 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		const proposer = stubProposer(() => IMPROVE);
		await adapt({
			task,
			seedSource: SEED,
			config: { ...QA_PROTOCOL, rounds: 2, proposals: 3, feedbackSize: 2, scoringSize: 3, budgets, concurrency: 4, seed: 2 },
			deps: { solver: solver(), proposer, python: stubPython() },
			runDir,
		});
		const seen = proposer.requests.map((r) => r.system + r.messages.map((m) => m.content).join("\n")).join("\n");
		for (const q of task.heldout) expect(seen).not.toContain(q.prompt);
		expect(proposer.requests).toHaveLength(6);
	});

	test("resumes after completed rounds", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 3, seed: 13 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-loop-"));
		await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 1 }),
			deps: { solver: solver(), proposer: stubProposer(() => "NO_CHANGE: wait"), python: stubPython() },
			runDir,
		});
		const second = stubProposer(() => IMPROVE);
		const summary = await adapt({
			task,
			seedSource: SEED,
			config: config({ rounds: 2 }),
			deps: { solver: solver(), proposer: second, python: stubPython() },
			runDir,
		});
		expect(second.requests).toHaveLength(1);
		expect(summary.rounds).toHaveLength(2);
		expect(summary.rounds[1].selection.chosen).toBe(0);
	});
});

describe("drawRoundSets", () => {
	test("QA protocol draws disjoint feedback and scoring sets", () => {
		const task = createArithmeticTask({ dev: 20, heldout: 1 });
		const { feedback, scoring } = drawRoundSets(task.dev, { feedbackSize: 6, scoringSize: 10, disjoint: true }, createRng(3));
		expect(feedback).toHaveLength(6);
		expect(scoring).toHaveLength(10);
		const ids = new Set(feedback.map((q) => q.id));
		for (const q of scoring) expect(ids.has(q.id)).toBe(false);
	});

	test("RG protocol uses the whole dev set for both", () => {
		const task = createArithmeticTask({ dev: 5, heldout: 1 });
		const { feedback, scoring } = drawRoundSets(task.dev, { feedbackSize: "all", scoringSize: "all", disjoint: false }, createRng(3));
		expect(feedback).toBe(task.dev);
		expect(scoring).toBe(task.dev);
	});
});

describe("independentRevisions", () => {
	test("scores each proposal on held-out; failed edits keep the seed score", async () => {
		const task = createArithmeticTask({ dev: 4, heldout: 4, seed: 14 });
		const runDir = await mkdtemp(join(tmpdir(), "tta-ind-"));
		const proposer = stubProposer((_, call) => (call === 1 ? IMPROVE : "nonsense"));
		const summary = await independentRevisions({
			task,
			seedSource: SEED,
			proposals: 2,
			deps: { solver: solver(), proposer, python: stubPython() },
			config: { budgets, concurrency: 4, attempts: 1, maxLines: 300, seed: 1, branchHints: true, feedbackSize: "all" },
			runDir,
		});
		expect(summary.seedHeldout).toBe(0);
		expect(summary.proposals.map((p) => p.heldout)).toEqual([1, 0]);
		expect(summary.mean).toBeCloseTo(0.5);
		expect(summary.bestOf).toBe(1);
		expect(summary.aboveSeed).toBeCloseTo(0.5);
		expect(summary.failedRate).toBeCloseTo(0.5);
		expect(proposer.requests[1].messages[0].content).toContain("proposal 2 of 2");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**File: `src/core/store.ts`**
```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvalResult } from "./types.ts";

/** Writes run artifacts under one directory. */
export class RunStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	async writeText(relative: string, text: string): Promise<void> {
		const path = join(this.dir, relative);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	}

	async writeJson(relative: string, value: unknown): Promise<void> {
		await this.writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
	}

	async readJson<T>(relative: string): Promise<T | undefined> {
		try {
			return JSON.parse(await readFile(join(this.dir, relative), "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	/** Writes `<relative>.json` (summary and per-question outcomes) and `<relative>.traces.jsonl`. */
	async writeEval(relative: string, result: EvalResult): Promise<void> {
		await this.writeJson(`${relative}.json`, { ...result, outcomes: result.outcomes.map((o) => ({ ...o, trace: undefined })) });
		const lines = result.outcomes.map((o) => JSON.stringify({ questionId: o.questionId, trace: o.trace }));
		await this.writeText(`${relative}.traces.jsonl`, `${lines.join("\n")}\n`);
	}
}
```

**File: `src/core/loop.ts`**
```ts
import { hashSource } from "../util/hash.ts";
import { createRng, shuffle } from "../util/random.ts";
import { clip, fmt } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { evaluateHarness } from "./executor.ts";
import { type Proposal, type ProposalStatus, propose } from "./proposer.ts";
import { buildReport, type RevisionRecord } from "./report.ts";
import { groupAdvantages, qaReward, rgReward } from "./reward.ts";
import { screenHarness } from "./screens.ts";
import { type ScoredCandidate, type Selection, type SelectionProtocol, selectNext } from "./select.ts";
import { RunStore } from "./store.ts";
import type { EvalResult, ProposerClient, PythonRunner, Question, SolverClient, Task, Usage } from "./types.ts";
import { UsageMeter } from "./usage.ts";

export interface AdaptConfig {
	/** T: number of revision rounds. */
	rounds: number;
	/** G: proposals sampled per round. */
	proposals: number;
	protocol: SelectionProtocol;
	/** |Q_fb| per round, or the whole development pool. */
	feedbackSize: number | "all";
	/** |Q_score| per round, or the whole development pool. */
	scoringSize: number | "all";
	/** Draw Q_score disjoint from Q_fb within each round. */
	disjoint: boolean;
	attempts: number;
	maxLines: number;
	budgets: Budgets;
	concurrency: number;
	seed: number;
	evaluateHeldout: boolean;
	branchHints: boolean;
	reward: "rg" | "qa";
}

export type ProtocolPreset = Omit<AdaptConfig, "budgets" | "concurrency" | "seed">;

/** Reasoning Gym protocol (App. B.1): one proposal per round, dev set for feedback and scoring, retained only if it improves. */
export const REASONING_GYM_PROTOCOL: ProtocolPreset = {
	rounds: 5,
	proposals: 1,
	protocol: "greedy",
	feedbackSize: "all",
	scoringSize: "all",
	disjoint: false,
	attempts: 3,
	maxLines: 300,
	evaluateHeldout: true,
	branchHints: false,
	reward: "rg",
};

/** Multi-hop QA protocol (App. D.3): eight proposals, 6 feedback and 64 disjoint scoring questions, advance to the best. */
export const QA_PROTOCOL: ProtocolPreset = {
	rounds: 10,
	proposals: 8,
	protocol: "best-of-g",
	feedbackSize: 6,
	scoringSize: 64,
	disjoint: true,
	attempts: 1,
	maxLines: 200,
	evaluateHeldout: true,
	branchHints: false,
	reward: "qa",
};

export interface AdaptDeps {
	solver: SolverClient;
	proposer: ProposerClient;
	python?: PythonRunner;
}

export interface AdaptParams {
	task: Task;
	seedSource: string;
	config: AdaptConfig;
	deps: AdaptDeps;
	runDir: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export interface RoleUsage extends Usage {
	calls: number;
}

export interface CandidateSummary {
	index: number;
	status: ProposalStatus;
	hash?: string;
	score: number | null;
	completedFraction: number;
	reward: number;
	advantage: number;
	attempts: number;
	summary: string;
	reason?: string;
}

export interface RoundSummary {
	round: number;
	parentHash: string;
	feedback: { size: number; score: number };
	scoring: { size: number; parentScore: number };
	candidates: CandidateSummary[];
	selection: Omit<Selection, "source"> & { hash: string };
	heldout?: number;
	usage: { solver: RoleUsage; proposer: RoleUsage };
	durationMs: number;
}

export interface AdaptSummary {
	task: string;
	runDir: string;
	seedHeldout?: number;
	finalHeldout?: number;
	rounds: RoundSummary[];
	finalHash: string;
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

interface LoopState {
	version: 1;
	completedRounds: number;
	currentSource: string;
	previousSource?: string;
	history: RevisionRecord[];
	rounds: RoundSummary[];
	seedHeldout?: number;
	shownQuestions: string[];
	shownAnswers: string[];
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

/** Draws Q_fb and Q_score for one round from the development pool. */
export function drawRoundSets(
	dev: readonly Question[],
	config: Pick<AdaptConfig, "feedbackSize" | "scoringSize" | "disjoint">,
	rng: () => number,
): { feedback: readonly Question[]; scoring: readonly Question[] } {
	if (config.feedbackSize === "all" && config.scoringSize === "all" && !config.disjoint) return { feedback: dev, scoring: dev };
	const order = shuffle(dev, rng);
	const nFeedback = config.feedbackSize === "all" ? order.length : Math.min(config.feedbackSize, order.length);
	const feedback = order.slice(0, nFeedback);
	const pool = config.disjoint ? order.slice(nFeedback) : shuffle(dev, rng);
	const nScoring = config.scoringSize === "all" ? pool.length : Math.min(config.scoringSize, pool.length);
	return { feedback, scoring: pool.slice(0, nScoring) };
}

export function meterSolver(client: SolverClient, meter: UsageMeter): SolverClient {
	return {
		complete: async (request, signal) => {
			const response = await client.complete(request, signal);
			meter.add(response.usage);
			return response;
		},
	};
}

export function meterProposer(client: ProposerClient, meter: UsageMeter): ProposerClient {
	return {
		complete: async (request, signal) => {
			const response = await client.complete(request, signal);
			meter.add(response.usage);
			return response;
		},
	};
}

/** Test-time adaptation (Eq. 4): T rounds of propose, apply, select, with held-out evaluation for reporting only. */
export async function adapt(p: AdaptParams): Promise<AdaptSummary> {
	const { task, config } = p;
	if (config.disjoint && config.feedbackSize === "all") throw new Error("disjoint feedback and scoring sets need a numeric feedbackSize");
	const log = p.log ?? (() => {});
	const store = new RunStore(p.runDir);
	const meters = { solver: new UsageMeter(), proposer: new UsageMeter() };
	const deps: CapabilityDeps = {
		solver: meterSolver(p.deps.solver, meters.solver),
		python: p.deps.python,
		search: task.search,
	};
	const proposer = meterProposer(p.deps.proposer, meters.proposer);
	const run = (source: string, questions: readonly Question[], label: string) =>
		evaluateHarness({ task, source, questions, label, deps, budgets: config.budgets, concurrency: config.concurrency, signal: p.signal });
	const heldoutCache = new Map<string, Promise<EvalResult>>();
	const heldout = (source: string, label: string): Promise<EvalResult> => {
		const key = hashSource(source);
		let pending = heldoutCache.get(key);
		if (!pending) {
			pending = run(source, task.heldout, label);
			heldoutCache.set(key, pending);
		}
		return pending;
	};
	const snapshot = () => ({ solver: meters.solver.snapshot(), proposer: meters.proposer.snapshot() });

	let state = await store.readJson<LoopState>("state.json");
	if (state) {
		log(`resuming ${p.runDir} after round ${state.completedRounds}`);
	} else {
		await store.writeJson("config.json", {
			task: { name: task.name, description: task.description, capabilities: task.capabilities, dev: task.dev.length, heldout: task.heldout.length },
			config,
		});
		await store.writeText("seed.js", p.seedSource);
		state = {
			version: 1,
			completedRounds: 0,
			currentSource: p.seedSource,
			history: [],
			rounds: [],
			shownQuestions: [],
			shownAnswers: [],
			usage: { solver: zeroRole(), proposer: zeroRole() },
		};
		if (config.evaluateHeldout && task.heldout.length > 0) {
			const before = snapshot();
			const seedHeldout = await heldout(p.seedSource, "round-00/heldout");
			await store.writeEval("round-00/heldout", seedHeldout);
			state.seedHeldout = seedHeldout.mean;
			state.usage = addRoles(state.usage, deltaRoles(snapshot(), before));
			log(`seed held-out ${fmt(seedHeldout.mean)} on ${task.heldout.length} questions`);
		}
		await store.writeJson("state.json", state);
	}

	for (let round = state.completedRounds + 1; round <= config.rounds; round++) {
		p.signal?.throwIfAborted();
		const started = Date.now();
		const before = snapshot();
		const dir = `round-${String(round).padStart(2, "0")}`;
		const parentSource = state.currentSource;
		const parentHash = hashSource(parentSource);
		const { feedback, scoring } = drawRoundSets(task.dev, config, createRng(config.seed * 7919 + round));
		if (scoring.length === 0) throw new Error("the scoring set is empty; enlarge the development pool");
		const feedbackEval = await run(parentSource, feedback, `${dir}/feedback`);
		await store.writeEval(`${dir}/feedback`, feedbackEval);
		const parentScoreEval = scoring === feedback ? feedbackEval : await run(parentSource, scoring, `${dir}/parent-score`);
		if (parentScoreEval !== feedbackEval) await store.writeEval(`${dir}/parent-score`, parentScoreEval);

		const report = buildReport({
			task,
			result: feedbackEval,
			questions: feedback,
			currentSource: parentSource,
			previousSource: state.previousSource,
			history: state.history,
		});
		await store.writeText(`${dir}/report.md`, report);
		for (const q of feedback) {
			if (!state.shownQuestions.includes(q.prompt)) state.shownQuestions.push(q.prompt);
			if (!state.shownAnswers.includes(q.answer)) state.shownAnswers.push(q.answer);
		}
		const shownQuestions = [...state.shownQuestions];
		const shownAnswers = [...state.shownAnswers];
		const screen = (source: string) => screenHarness(source, { maxLines: config.maxLines, shownQuestions, shownAnswers });
		log(
			`round ${round}: parent ${parentHash} feedback ${fmt(feedbackEval.mean)} (${feedback.length}q), scoring ${fmt(parentScoreEval.mean)} (${scoring.length}q); sampling ${config.proposals} proposal(s)`,
		);

		const proposals = await Promise.all(
			Array.from({ length: config.proposals }, (_, index) =>
				propose({
					client: proposer,
					task,
					capabilities: task.capabilities,
					budgets: config.budgets,
					parentSource,
					parentScore: feedbackEval.mean,
					feedbackSize: feedback.length,
					report,
					maxLines: config.maxLines,
					attempts: config.attempts,
					branch: config.branchHints && config.proposals > 1 ? { index, total: config.proposals } : undefined,
					screen,
					signal: p.signal,
				}),
			),
		);

		const roundEvals = new Map<string, Promise<EvalResult>>();
		const scored = await Promise.all(
			proposals.map(async (proposal, index): Promise<{ proposal: Proposal; candidate: ScoredCandidate }> => {
				const cdir = `${dir}/candidates/c${index}`;
				await store.writeJson(`${cdir}/proposal.json`, { ...proposal, source: undefined, system: undefined, transcript: undefined });
				await store.writeText(`${cdir}/transcript.md`, renderTranscript(proposal));
				if (proposal.status === "invalid") {
					return { proposal, candidate: { index, status: "invalid", source: null, score: null, completedFraction: 0 } };
				}
				if (proposal.status === "no_change") {
					return {
						proposal,
						candidate: {
							index,
							status: "no_change",
							source: parentSource,
							score: parentScoreEval.mean,
							completedFraction: parentScoreEval.completedFraction,
						},
					};
				}
				const source = proposal.source as string;
				await store.writeText(`${cdir}/harness.js`, source);
				const key = hashSource(source);
				let pending = roundEvals.get(key);
				if (!pending) {
					pending = run(source, scoring, `${cdir}/score`);
					roundEvals.set(key, pending);
				}
				const result = await pending;
				await store.writeEval(`${cdir}/score`, result);
				return {
					proposal,
					candidate: { index, status: "edit", source, score: result.mean, completedFraction: result.completedFraction },
				};
			}),
		);

		const selection = selectNext(config.protocol, { source: parentSource, score: parentScoreEval.mean }, scored.map((s) => s.candidate));
		const rewards = scored.map(({ proposal, candidate }) =>
			config.reward === "rg"
				? rgReward({
						parsed: proposal.parsed || proposal.status === "no_change",
						applied: candidate.status !== "invalid",
						completedFraction: candidate.completedFraction,
						score: candidate.score ?? 0,
					})
				: qaReward({ valid: candidate.status !== "invalid" && candidate.completedFraction > 0, score: candidate.score ?? 0 }),
		);
		const advantages = groupAdvantages(rewards);
		const candidates: CandidateSummary[] = scored.map(({ proposal, candidate }, i) => ({
			index: candidate.index,
			status: candidate.status,
			hash: candidate.status === "edit" && candidate.source ? hashSource(candidate.source) : undefined,
			score: candidate.score,
			completedFraction: candidate.completedFraction,
			reward: rewards[i],
			advantage: advantages[i],
			attempts: proposal.attempts,
			summary: summarizeProposal(proposal),
			reason: proposal.status === "edit" ? undefined : proposal.reason,
		}));
		for (const c of candidates) {
			state.history.push({
				round,
				candidate: c.index,
				status: c.status === "edit" ? (selection.chosen === c.index ? "accepted" : "rejected") : c.status,
				score: c.score,
				parentScore: parentScoreEval.mean,
				summary: c.status === "invalid" ? `invalid: ${c.reason ?? ""}` : c.summary,
			});
		}
		if (selection.chosen !== null) {
			state.previousSource = parentSource;
			state.currentSource = selection.source;
		}
		await store.writeText(`${dir}/selected.js`, state.currentSource);

		let heldoutScore: number | undefined;
		if (config.evaluateHeldout && task.heldout.length > 0) {
			const result = await heldout(state.currentSource, `${dir}/heldout`);
			await store.writeEval(`${dir}/heldout`, result);
			heldoutScore = result.mean;
		}
		const roundUsage = deltaRoles(snapshot(), before);
		const summary: RoundSummary = {
			round,
			parentHash,
			feedback: { size: feedback.length, score: feedbackEval.mean },
			scoring: { size: scoring.length, parentScore: parentScoreEval.mean },
			candidates,
			selection: { score: selection.score, chosen: selection.chosen, reason: selection.reason, hash: hashSource(state.currentSource) },
			heldout: heldoutScore,
			usage: roundUsage,
			durationMs: Date.now() - started,
		};
		state.rounds.push(summary);
		state.usage = addRoles(state.usage, roundUsage);
		state.completedRounds = round;
		await store.writeJson(`${dir}/round.json`, summary);
		await store.writeJson("state.json", state);
		log(`round ${round}: ${selection.reason}${heldoutScore === undefined ? "" : `; held-out ${fmt(heldoutScore)}`}`);
	}

	const last = state.rounds[state.rounds.length - 1];
	const result: AdaptSummary = {
		task: task.name,
		runDir: p.runDir,
		seedHeldout: state.seedHeldout,
		finalHeldout: last?.heldout ?? state.seedHeldout,
		rounds: state.rounds,
		finalHash: hashSource(state.currentSource),
		usage: state.usage,
	};
	await store.writeText("final.js", state.currentSource);
	await store.writeJson("summary.json", result);
	await store.writeText("summary.md", renderSummary(result));
	return result;
}

export function zeroRole(): RoleUsage {
	return { input: 0, output: 0, cost: 0, calls: 0 };
}

function addRole(a: RoleUsage, b: RoleUsage): RoleUsage {
	return { input: a.input + b.input, output: a.output + b.output, cost: a.cost + b.cost, calls: a.calls + b.calls };
}

function addRoles(a: { solver: RoleUsage; proposer: RoleUsage }, b: { solver: RoleUsage; proposer: RoleUsage }) {
	return { solver: addRole(a.solver, b.solver), proposer: addRole(a.proposer, b.proposer) };
}

function deltaRoles(after: { solver: RoleUsage; proposer: RoleUsage }, before: { solver: RoleUsage; proposer: RoleUsage }) {
	const delta = (x: RoleUsage, y: RoleUsage): RoleUsage => ({
		input: x.input - y.input,
		output: x.output - y.output,
		cost: x.cost - y.cost,
		calls: x.calls - y.calls,
	});
	return { solver: delta(after.solver, before.solver), proposer: delta(after.proposer, before.proposer) };
}

export function summarizeProposal(proposal: Proposal): string {
	return clip((proposal.manifest ?? proposal.diagnosis ?? proposal.reason ?? "").replace(/\s+/g, " ").trim(), 300);
}

export function renderTranscript(proposal: Proposal): string {
	const parts = [`# Proposal: ${proposal.status} after ${proposal.attempts} attempt(s)`, `## System\n${proposal.system}`];
	proposal.transcript.forEach((m, i) => {
		parts.push(`## ${i + 1}. ${m.role}\n${m.content}`);
	});
	if (proposal.errors.length > 0) parts.push(`## Errors\n${proposal.errors.map((e) => `- ${e}`).join("\n")}`);
	return parts.join("\n\n");
}

export function renderUsage(role: string, usage: RoleUsage): string {
	return `${role}: ${usage.calls} calls, ${usage.input} input / ${usage.output} output tokens, $${usage.cost.toFixed(3)}`;
}

function renderSummary(s: AdaptSummary): string {
	const score = (x: number | undefined) => (x === undefined ? "–" : fmt(x));
	const rows = s.rounds.map((r) => {
		const candidates = r.candidates.map((c) => `${c.status}:${c.score === null ? "–" : fmt(c.score)}`).join(", ");
		const selected = r.selection.chosen === null ? "parent kept" : `candidate ${r.selection.chosen}`;
		return `| ${r.round} | ${fmt(r.feedback.score)} | ${fmt(r.scoring.parentScore)} | ${candidates} | ${selected} | ${score(r.heldout)} |`;
	});
	const delta =
		s.seedHeldout !== undefined && s.finalHeldout !== undefined ? ` (${s.finalHeldout - s.seedHeldout >= 0 ? "+" : ""}${fmt(s.finalHeldout - s.seedHeldout)})` : "";
	return [
		`# Adaptation run: ${s.task}`,
		`Held-out: seed ${score(s.seedHeldout)} -> final ${score(s.finalHeldout)}${delta}. Final harness ${s.finalHash}.`,
		"",
		"| Round | Parent feedback | Parent scoring | Candidates (status:score) | Selected | Held-out |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
		renderUsage("Solver", s.usage.solver),
		"",
		renderUsage("Proposer", s.usage.proposer),
		"",
	].join("\n");
}
```

**File: `src/core/independent.ts`**
```ts
import { hashSource } from "../util/hash.ts";
import { createRng, shuffle } from "../util/random.ts";
import { fmt } from "../util/text.ts";
import type { Budgets, CapabilityDeps } from "./capabilities.ts";
import { evaluateHarness } from "./executor.ts";
import { type AdaptDeps, meterProposer, meterSolver, type RoleUsage, renderTranscript, renderUsage, summarizeProposal } from "./loop.ts";
import { type ProposalStatus, propose } from "./proposer.ts";
import { buildReport } from "./report.ts";
import { screenHarness } from "./screens.ts";
import { RunStore } from "./store.ts";
import type { EvalResult, Task } from "./types.ts";
import { UsageMeter } from "./usage.ts";

export interface IndependentConfig {
	budgets: Budgets;
	concurrency: number;
	attempts: number;
	maxLines: number;
	seed: number;
	branchHints: boolean;
	feedbackSize: number | "all";
}

export interface IndependentParams {
	task: Task;
	seedSource: string;
	proposals: number;
	deps: AdaptDeps;
	config: IndependentConfig;
	runDir: string;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export interface IndependentProposal {
	index: number;
	status: ProposalStatus;
	hash?: string;
	heldout: number;
	attempts: number;
	summary: string;
	reason?: string;
}

export interface IndependentSummary {
	task: string;
	runDir: string;
	seedFeedback: number;
	seedHeldout: number;
	proposals: IndependentProposal[];
	/** Mean held-out score over all proposals; failed edits and no-change keep the seed score. */
	mean: number;
	/** Oracle best-of-N selected on held-out scores (not a deployable rule). */
	bestOf: number;
	aboveSeed: number;
	failedRate: number;
	usage: { solver: RoleUsage; proposer: RoleUsage };
}

/** Single-step revision (App. B.1, D.4): N independent proposals from the seed and one fixed report. */
export async function independentRevisions(p: IndependentParams): Promise<IndependentSummary> {
	const { task, config } = p;
	const log = p.log ?? (() => {});
	const store = new RunStore(p.runDir);
	const meters = { solver: new UsageMeter(), proposer: new UsageMeter() };
	const deps: CapabilityDeps = { solver: meterSolver(p.deps.solver, meters.solver), python: p.deps.python, search: task.search };
	const proposer = meterProposer(p.deps.proposer, meters.proposer);
	const run = (source: string, label: string, questions = task.heldout) =>
		evaluateHarness({ task, source, questions, label, deps, budgets: config.budgets, concurrency: config.concurrency, signal: p.signal });
	const cache = new Map<string, Promise<EvalResult>>();
	const heldout = (source: string, label: string) => {
		const key = hashSource(source);
		let pending = cache.get(key);
		if (!pending) {
			pending = run(source, label);
			cache.set(key, pending);
		}
		return pending;
	};

	await store.writeJson("config.json", { task: task.name, proposals: p.proposals, config });
	await store.writeText("seed.js", p.seedSource);
	const feedback = config.feedbackSize === "all" ? task.dev : shuffle(task.dev, createRng(config.seed)).slice(0, config.feedbackSize);
	const feedbackEval = await run(p.seedSource, "seed-feedback", feedback);
	await store.writeEval("seed-feedback", feedbackEval);
	const seedHeldout = await heldout(p.seedSource, "seed-heldout");
	await store.writeEval("seed-heldout", seedHeldout);
	log(`seed feedback ${fmt(feedbackEval.mean)} (${feedback.length}q), held-out ${fmt(seedHeldout.mean)} (${task.heldout.length}q)`);
	const report = buildReport({ task, result: feedbackEval, questions: feedback, currentSource: p.seedSource, history: [] });
	await store.writeText("report.md", report);
	const shownQuestions = feedback.map((q) => q.prompt);
	const shownAnswers = feedback.map((q) => q.answer);

	const proposals = await Promise.all(
		Array.from({ length: p.proposals }, (_, index) =>
			propose({
				client: proposer,
				task,
				capabilities: task.capabilities,
				budgets: config.budgets,
				parentSource: p.seedSource,
				parentScore: feedbackEval.mean,
				feedbackSize: feedback.length,
				report,
				maxLines: config.maxLines,
				attempts: config.attempts,
				branch: config.branchHints && p.proposals > 1 ? { index, total: p.proposals } : undefined,
				screen: (source) => screenHarness(source, { maxLines: config.maxLines, shownQuestions, shownAnswers }),
				signal: p.signal,
			}),
		),
	);
	const results = await Promise.all(
		proposals.map(async (proposal, index): Promise<IndependentProposal> => {
			const dir = `proposals/p${index}`;
			await store.writeText(`${dir}/transcript.md`, renderTranscript(proposal));
			let score = seedHeldout.mean;
			let hash: string | undefined;
			if (proposal.status === "edit" && proposal.source) {
				hash = hashSource(proposal.source);
				await store.writeText(`${dir}/harness.js`, proposal.source);
				const result = await heldout(proposal.source, `${dir}/heldout`);
				await store.writeEval(`${dir}/heldout`, result);
				score = result.mean;
			}
			log(`proposal ${index}: ${proposal.status}, held-out ${fmt(score)}`);
			return {
				index,
				status: proposal.status,
				hash,
				heldout: score,
				attempts: proposal.attempts,
				summary: summarizeProposal(proposal),
				reason: proposal.status === "edit" ? undefined : proposal.reason,
			};
		}),
	);
	const scores = results.map((r) => r.heldout);
	const n = Math.max(scores.length, 1);
	const summary: IndependentSummary = {
		task: task.name,
		runDir: p.runDir,
		seedFeedback: feedbackEval.mean,
		seedHeldout: seedHeldout.mean,
		proposals: results,
		mean: scores.reduce((a, b) => a + b, 0) / n,
		bestOf: scores.length ? Math.max(...scores) : seedHeldout.mean,
		aboveSeed: scores.filter((s) => s > seedHeldout.mean).length / n,
		failedRate: results.filter((r) => r.status === "invalid").length / n,
		usage: { solver: meters.solver.snapshot(), proposer: meters.proposer.snapshot() },
	};
	await store.writeJson("summary.json", summary);
	await store.writeText(
		"summary.md",
		[
			`# Independent revisions: ${task.name}`,
			`Seed held-out ${fmt(summary.seedHeldout)}. Mean of ${results.length} proposals ${fmt(summary.mean)}, oracle best ${fmt(summary.bestOf)}, ${fmt(summary.aboveSeed * 100, 1)}% above seed, ${fmt(summary.failedRate * 100, 1)}% failed edits.`,
			"",
			"| Proposal | Status | Held-out | Change |",
			"|---|---|---|---|",
			...results.map((r) => `| ${r.index} | ${r.status} | ${fmt(r.heldout)} | ${r.summary.replace(/\|/g, "\\|")} |`),
			"",
			renderUsage("Solver", summary.usage.solver),
			"",
			renderUsage("Proposer", summary.usage.proposer),
			"",
		].join("\n"),
	);
	return summary;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/loop.test.ts && npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/loop.ts src/core/independent.ts test/loop.test.ts
git commit -m "feat: test-time adaptation loop (Eq. 4) with artifacts, resume, and single-step mode"
git push origin main
```

---

### Task 11: Bedrock clients through pi-ai

**Files:**
- Create: `src/config.ts`, `src/llm/pi-clients.ts`
- Test: `test/pi-clients.test.ts`

**Interfaces:**
- Consumes: `SolverClient`, `ProposerClient` and request/response types (Task 3); `Semaphore`, `sleep` (Task 2).
- Produces: `repoPath(...parts)`, `defaultPythonPath()`, `DEFAULT_PROPOSER_MODEL`, `DEFAULT_SOLVER_MODEL`; `createBedrockModels()`, `requireModel(models, id, provider?)`, `RetryPolicy`, `DEFAULT_RETRY`, `isRetryable(message)`, `stripThinking(text)`, `completeWithRetry(call, policy, signal?, onRetry?)`, `PiSolverClient`, `PiProposerClient`.

- [ ] **Step 1: Write the failing test**

**Test: `test/pi-clients.test.ts`**
```ts
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { isRetryable, PiProposerClient, PiSolverClient, stripThinking } from "../src/llm/pi-clients.ts";

type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function setup(steps: Steps) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(steps);
	return { faux, models, model: faux.getModel() };
}

const fast = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe("PiSolverClient", () => {
	test("sends the system prompt and multi-turn messages and strips thinking tags", async () => {
		let seen = "";
		const { models, model } = setup([
			(context) => {
				seen = JSON.stringify(context);
				return fauxAssistantMessage("<think>hmm</think>Answer: 4");
			},
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		const response = await client.complete({
			system: "sys",
			messages: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: "second" },
				{ role: "user", content: "third" },
			],
			maxTokens: 100,
		});
		expect(response.text).toBe("Answer: 4");
		expect(response.stopReason).toBe("stop");
		for (const part of ["sys", "first", "second", "third"]) expect(seen).toContain(part);
	});

	test("retries throttling then succeeds", async () => {
		const { models, model, faux } = setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ThrottlingException: Too many requests" }),
			fauxAssistantMessage("ok"),
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		const response = await client.complete({ messages: [{ role: "user", content: "x" }], maxTokens: 10 });
		expect(response.text).toBe("ok");
		expect(faux.state.callCount).toBe(2);
	});

	test("does not retry validation errors", async () => {
		const { models, model, faux } = setup([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ValidationException: bad input" }),
			fauxAssistantMessage("never"),
		]);
		const client = new PiSolverClient({ models, model, retry: fast });
		await expect(client.complete({ messages: [{ role: "user", content: "x" }], maxTokens: 10 })).rejects.toThrow(
			"ValidationException",
		);
		expect(faux.state.callCount).toBe(1);
	});
});

describe("PiProposerClient", () => {
	test("returns final text without thinking and reports errors", async () => {
		const { models, model } = setup([
			fauxAssistantMessage([fauxThinking("plan"), fauxText("NO_CHANGE: fine")]),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "ValidationException: nope" }),
		]);
		const client = new PiProposerClient({ models, model, retry: fast });
		const ok = await client.complete({ system: "s", messages: [{ role: "user", content: "u" }] });
		expect(ok.text).toBe("NO_CHANGE: fine");
		const bad = await client.complete({ system: "s", messages: [{ role: "user", content: "u" }] });
		expect(bad.stopReason).toBe("error");
		expect(bad.error).toContain("ValidationException");
	});
});

describe("helpers", () => {
	test("isRetryable and stripThinking", () => {
		expect(isRetryable("ThrottlingException: Rate exceeded")).toBe(true);
		expect(isRetryable("ServiceUnavailableException: try later")).toBe(true);
		expect(isRetryable("ValidationException: The model returned the following errors")).toBe(false);
		expect(stripThinking("<think>a</think>\nB")).toBe("B");
		expect(stripThinking("reasoning</think>C")).toBe("C");
		expect(stripThinking("plain")).toBe("plain");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi-clients.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `src/config.ts`**
```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

/** Absolute path inside this repository. */
export function repoPath(...parts: string[]): string {
	return fileURLToPath(new URL(parts.join("/"), ROOT));
}

/** Python used for solver code and the Reasoning Gym bridge: $TTA_PYTHON, then .venv, then python3. */
export function defaultPythonPath(): string {
	const fromEnv = process.env.TTA_PYTHON;
	if (fromEnv) return fromEnv;
	const venv = repoPath(".venv", "bin", "python");
	return existsSync(venv) ? venv : "python3";
}

export const DEFAULT_PROPOSER_MODEL = "us.anthropic.claude-opus-5-5";
export const DEFAULT_SOLVER_MODEL = "us.meta.llama3-1-8b-instruct-v1:0";
```

**File: `src/llm/pi-clients.ts`**
```ts
import {
	type Api,
	type AssistantMessage,
	type Context,
	createModels,
	type Message,
	type Model,
	type Models,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import type {
	ProposerClient,
	ProposerRequest,
	ProposerResponse,
	SolverClient,
	SolverMessage,
	SolverRequest,
	SolverResponse,
	Usage,
} from "../core/types.ts";
import { type Semaphore, sleep } from "../util/concurrency.ts";

/** A pi-ai model collection with the Amazon Bedrock provider (ambient AWS credentials). */
export function createBedrockModels(): Models {
	const models = createModels();
	models.setProvider(amazonBedrockProvider());
	return models;
}

export function requireModel(models: Models, id: string, provider = "amazon-bedrock"): Model<Api> {
	const model = models.getModel(provider, id);
	if (!model) {
		throw new Error(`Unknown ${provider} model "${id}". Use an id from pi-ai's catalog, for example us.anthropic.claude-opus-5-5.`);
	}
	return model;
}

export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 30_000 };

const RETRYABLE =
	/throttl|too many|rate.?limit|rate exceeded|\b429\b|\b50[0-4]\b|service.?unavailable|internal.?server|internalfailure|timed? ?out|timeout|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|overloaded|not ready|try again|network/i;

export function isRetryable(message: string | undefined): boolean {
	return RETRYABLE.test(message ?? "");
}

/** Removes <think>...</think> blocks that some open models emit inline. */
export function stripThinking(text: string): string {
	let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	const close = out.lastIndexOf("</think>");
	if (close >= 0) out = out.slice(close + "</think>".length);
	return out.trimStart();
}

/** pi-ai reports failures as messages with stopReason "error"; retry the transient ones with backoff and jitter. */
export async function completeWithRetry(
	call: () => Promise<AssistantMessage>,
	policy: RetryPolicy,
	signal?: AbortSignal,
	onRetry?: (attempt: number, message: string) => void,
): Promise<AssistantMessage> {
	for (let attempt = 1; ; attempt++) {
		const message = await call();
		if (message.stopReason !== "error") return message;
		if (attempt >= policy.maxAttempts || signal?.aborted || !isRetryable(message.errorMessage)) return message;
		onRetry?.(attempt, message.errorMessage ?? "");
		const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
		await sleep(delay, signal);
	}
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toContext(model: Model<Api>, system: string | undefined, messages: readonly SolverMessage[]): Context {
	const timestamp = Date.now();
	return {
		systemPrompt: system,
		messages: messages.map(
			(m): Message =>
				m.role === "user"
					? { role: "user", content: m.content, timestamp }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.content }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage(),
							stopReason: "stop",
							timestamp,
						},
		),
	};
}

function textOf(message: AssistantMessage): string {
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}

function usageOf(message: AssistantMessage): Usage {
	return { input: message.usage.input, output: message.usage.output, cost: message.usage.cost.total };
}

export interface PiClientOptions {
	models: Models;
	model: Model<Api>;
	retry?: RetryPolicy;
	/** Bounds concurrent requests across all callers of this client. */
	limiter?: Semaphore;
	onRetry?: (attempt: number, message: string) => void;
}

/** Frozen solver: a pi-ai model behind the harness's llm() global. */
export class PiSolverClient implements SolverClient {
	private readonly options: PiClientOptions & { temperature?: number };

	constructor(options: PiClientOptions & { temperature?: number }) {
		this.options = options;
	}

	async complete(request: SolverRequest, signal?: AbortSignal): Promise<SolverResponse> {
		const { models, model } = this.options;
		const context = toContext(model, request.system, request.messages);
		const temperature = request.temperature ?? this.options.temperature;
		const call = () =>
			completeWithRetry(
				() => models.complete(model, context, { maxTokens: request.maxTokens, temperature, signal }),
				this.options.retry ?? DEFAULT_RETRY,
				signal,
				this.options.onRetry,
			);
		const message = this.options.limiter ? await this.options.limiter.run(call) : await call();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(`solver model error: ${message.errorMessage ?? message.stopReason}`);
		}
		return { text: stripThinking(textOf(message)), stopReason: message.stopReason, usage: usageOf(message) };
	}
}

/** Proposer: a pi-ai model with optional reasoning; returns final text only. */
export class PiProposerClient implements ProposerClient {
	private readonly options: PiClientOptions & { reasoning?: ThinkingLevel; maxTokens?: number };

	constructor(options: PiClientOptions & { reasoning?: ThinkingLevel; maxTokens?: number }) {
		this.options = options;
	}

	async complete(request: ProposerRequest, signal?: AbortSignal): Promise<ProposerResponse> {
		const { models, model } = this.options;
		const context = toContext(model, request.system, request.messages);
		const maxTokens = Math.min(this.options.maxTokens ?? 32_000, model.maxTokens);
		const call = () =>
			completeWithRetry(
				() => models.completeSimple(model, context, { maxTokens, reasoning: this.options.reasoning, signal }),
				this.options.retry ?? DEFAULT_RETRY,
				signal,
				this.options.onRetry,
			);
		const message = this.options.limiter ? await this.options.limiter.run(call) : await call();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return { text: "", stopReason: "error", usage: usageOf(message), error: message.errorMessage ?? message.stopReason };
		}
		return { text: textOf(message), stopReason: message.stopReason, usage: usageOf(message) };
	}
}
```

- [ ] **Step 4: Run tests and a live smoke check**

Run: `npx vitest run test/pi-clients.test.ts && npm run check`
Expected: all pass. If a pi-ai export name differs (for example `Models` or `ThinkingLevel`), read `node_modules/@earendil-works/pi-ai/dist/index.d.ts` and use the exported name.

Run (live, Bedrock):
```bash
AWS_PROFILE=<aws-profile> AWS_REGION=us-east-1 node -e '
import("./src/llm/pi-clients.ts").then(async ({ createBedrockModels, requireModel, PiSolverClient, PiProposerClient }) => {
  const models = createBedrockModels();
  const solver = new PiSolverClient({ models, model: requireModel(models, "us.amazon.nova-micro-v1:0") });
  console.log("solver:", (await solver.complete({ messages: [{ role: "user", content: "2+2? Number only." }], maxTokens: 20 })).text);
  const proposer = new PiProposerClient({ models, model: requireModel(models, "us.anthropic.claude-opus-5-5"), reasoning: "low" });
  const r = await proposer.complete({ system: "Be brief.", messages: [{ role: "user", content: "Say OK." }] });
  console.log("proposer:", r.stopReason, r.text.slice(0, 40), r.error ?? "");
});'
```
Expected: `solver: 4` and `proposer: stop OK`.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/llm/pi-clients.ts test/pi-clients.test.ts
git commit -m "feat: Bedrock solver and proposer clients through pi-ai with retries"
git push origin main
```

---

### Task 12: Guarded Python runner

**Files:**
- Create: `python/guard.py`, `src/tools/python.ts`
- Test: `test/python.test.ts`

**Interfaces:**
- Consumes: `PythonRunner`, `PythonResult` (Task 3); `repoPath` (Task 11); `Semaphore` (Task 2).
- Produces: `createPythonRunner({pythonPath, maxOutputChars?, maxConcurrent?}): PythonRunner`, `runProcess(command, args, options): Promise<PythonResult>`.

- [ ] **Step 1: Write the failing test**

**Test: `test/python.test.ts`**
```ts
import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { defaultPythonPath, repoPath } from "../src/config.ts";
import { createPythonRunner } from "../src/tools/python.ts";

const runner = createPythonRunner({ pythonPath: defaultPythonPath() });
const run = (code: string, timeoutMs = 10_000, stdin?: string) => runner.run(code, { timeoutMs, stdin });

describe("guarded python", () => {
	test("runs code with stdin", async () => {
		const result = await run("import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))", 10_000, "1 2 3");
		expect(result).toMatchObject({ stdout: "6\n", exitCode: 0, timedOut: false });
	});

	test("reports exceptions", async () => {
		const result = await run("raise ValueError('bad')");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("ValueError: bad");
	});

	test("times out", async () => {
		const result = await run("while True: pass", 1000);
		expect(result.timedOut).toBe(true);
	});

	test("blocks network access", async () => {
		const result = await run("import socket\nsocket.create_connection(('1.1.1.1', 80), timeout=2)");
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("blocked");
	});

	test("blocks subprocesses", async () => {
		expect((await run("import subprocess\nsubprocess.run(['echo', 'hi'])")).stderr).toContain("blocked");
		expect((await run("import os\nos.system('echo hi')")).stderr).toContain("blocked");
	});

	test("blocks reads and writes outside the scratch directory", async () => {
		expect((await run("import os\nprint(open(os.path.expanduser('~/.aws/credentials')).read())")).stderr).toContain("blocked");
		expect((await run("open('/tmp/tta-guard-test.txt', 'w').write('x')")).stderr).toContain("blocked");
		expect((await run("import os\nprint(os.listdir(os.path.expanduser('~')))")).stderr).toContain("blocked");
		const local = await run("open('ok.txt', 'w').write('x')\nprint(open('ok.txt').read())");
		expect(local.stdout).toBe("x\n");
	});

	test("scrubs the environment", async () => {
		process.env.AWS_TTA_TEST_ONLY = "should-not-leak";
		const result = await run("import os\nprint(sorted(k for k in os.environ if 'AWS' in k))");
		delete process.env.AWS_TTA_TEST_ONLY;
		expect(result.stdout).toBe("[]\n");
	});

	test.skipIf(!existsSync(repoPath(".venv", "bin", "python")))("imports numpy and sympy", async () => {
		const result = await run("import numpy, sympy\nprint(int(numpy.sum([1, 2])), sympy.factorint(12))");
		expect(result.stdout).toBe("3 {2: 2, 3: 1}\n");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/python.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**File: `python/guard.py`**
```python
"""Best-effort isolation for solver-written Python code.

Usage: python -I -B guard.py <scratch_dir> <code_file> <cpu_seconds>

The code runs with resource limits and a PEP 578 audit hook that blocks network access, process
creation, ctypes, and file access outside the scratch directory and the Python installation.
This is defense in depth, not a security boundary: run inside a container for untrusted settings.
"""

import os
import resource
import sys

BLOCKED_PREFIXES = (
    "socket.", "subprocess.", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork",
    "os.forkpty", "os.kill", "os.killpg", "pty.", "ctypes.", "_winapi.", "webbrowser.",
    "urllib.Request", "http.client.", "ftplib.", "smtplib.", "poplib.", "imaplib.", "nntplib.",
    "telnetlib.", "os.startfile", "os.putenv", "os.unsetenv", "sys.remote_exec",
)
BLOCKED_MODULES = {"ctypes", "_ctypes", "cffi", "_posixsubprocess", "multiprocessing", "_multiprocessing"}
READ_PATH_EVENTS = {"os.listdir", "os.scandir", "glob.glob", "os.chdir"}
WRITE_PATH_EVENTS = {
    "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.symlink", "os.link",
    "os.truncate", "os.utime", "shutil.rmtree", "shutil.copyfile", "shutil.move",
}
TWO_PATH_EVENTS = {"os.rename", "os.symlink", "os.link", "shutil.copyfile", "shutil.move"}
DEVICES = {"/dev/null", "/dev/urandom", "/dev/random", "/dev/zero"}
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def _limit(kind, value):
    try:
        resource.setrlimit(kind, (value, value))
    except (ValueError, OSError):
        pass


def _install(scratch):
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, *sys.path}
    read_roots = tuple(sorted({os.path.realpath(r) for r in roots if r} | {scratch}))
    write_roots = (scratch,)

    def inside(path, allowed):
        if isinstance(path, int) or path is None:
            return True
        try:
            real = os.path.realpath(os.fsdecode(path))
        except Exception:
            return False
        return real in DEVICES or any(real == r or real.startswith(r + os.sep) for r in allowed)

    def deny(event, detail=""):
        raise PermissionError(f"blocked by sandbox: {event} {detail}".strip())

    def hook(event, args):
        if event.startswith(BLOCKED_PREFIXES):
            deny(event)
        if event == "import":
            name = (args[0] or "").split(".")[0]
            if name in BLOCKED_MODULES:
                raise ImportError(f"blocked by sandbox: import {args[0]}")
            return
        if event == "open":
            path, mode, flags = (list(args) + [None, None, None])[:3]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and bool(flags & WRITE_FLAGS)
            )
            if not inside(path, write_roots if writing else read_roots):
                deny("open", repr(path))
            return
        if event in READ_PATH_EVENTS or event in WRITE_PATH_EVENTS:
            allowed = write_roots if event in WRITE_PATH_EVENTS else read_roots
            if args and not inside(args[0], allowed):
                deny(event, repr(args[0]))
            if event in TWO_PATH_EVENTS and len(args) > 1 and not inside(args[1], write_roots):
                deny(event, repr(args[1]))

    sys.addaudithook(hook)


def main():
    scratch = os.path.realpath(sys.argv[1])
    code_path = sys.argv[2]
    cpu_seconds = int(sys.argv[3])
    with open(code_path, encoding="utf-8") as handle:
        source = handle.read()
    _limit(resource.RLIMIT_CPU, cpu_seconds)
    _limit(resource.RLIMIT_FSIZE, 16 << 20)
    if sys.platform == "darwin":
        _limit(resource.RLIMIT_NPROC, 0)
    if sys.platform.startswith("linux"):
        _limit(resource.RLIMIT_AS, 2 << 30)
    os.chdir(scratch)
    code = compile(source, "solver.py", "exec")
    _install(scratch)
    sys.argv = ["solver.py"]
    exec(code, {"__name__": "__main__", "__builtins__": __builtins__})


if __name__ == "__main__":
    main()
```

**File: `src/tools/python.ts`**
```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../config.ts";
import type { PythonResult, PythonRunner } from "../core/types.ts";
import { Semaphore } from "../util/concurrency.ts";

export interface PythonRunnerOptions {
	pythonPath: string;
	maxOutputChars?: number;
	maxConcurrent?: number;
}

/** Runs solver-written Python through python/guard.py with a scrubbed environment and a temp working directory. */
export function createPythonRunner(o: PythonRunnerOptions): PythonRunner {
	const guard = repoPath("python", "guard.py");
	const limiter = new Semaphore(o.maxConcurrent ?? 8);
	const maxChars = o.maxOutputChars ?? 20_000;
	return {
		run: (code, options) =>
			limiter.run(async () => {
				const scratch = await mkdtemp(join(tmpdir(), "tta-py-"));
				try {
					const codePath = join(scratch, "solver.py");
					await writeFile(codePath, code);
					const cpuSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
					return await runProcess(
						o.pythonPath,
						["-I", "-B", "-X", "utf8", guard, scratch, codePath, String(cpuSeconds)],
						{ cwd: scratch, env: scrubbedEnv(scratch), stdin: options.stdin, timeoutMs: options.timeoutMs, signal: options.signal, maxChars },
					);
				} finally {
					await rm(scratch, { recursive: true, force: true });
				}
			}),
	};
}

/** Only these variables reach the child: no credentials or provider configuration. */
function scrubbedEnv(scratch: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		HOME: scratch,
		TMPDIR: scratch,
		OPENBLAS_NUM_THREADS: "1",
		OMP_NUM_THREADS: "1",
		MKL_NUM_THREADS: "1",
	};
}

export function runProcess(
	command: string,
	args: string[],
	o: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal; maxChars: number },
): Promise<PythonResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
		const out = { stdout: "", stderr: "" };
		let timedOut = false;
		let settled = false;
		const append = (key: "stdout" | "stderr", chunk: Buffer) => {
			if (out[key].length >= o.maxChars) return;
			out[key] += chunk.toString("utf8");
			if (out[key].length >= o.maxChars) out[key] = `${out[key].slice(0, o.maxChars)}\n[output truncated]`;
		};
		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		const kill = () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, o.timeoutMs + 250);
		o.signal?.addEventListener("abort", kill, { once: true });
		const done = () => {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", kill);
		};
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			done();
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			done();
			if (signal === "SIGXCPU") timedOut = true;
			resolve({ stdout: out.stdout, stderr: out.stderr, exitCode: code, timedOut });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(o.stdin ?? "");
	});
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/python.test.ts && npm run check`
Expected: all pass (the numpy/sympy test runs only when `.venv` exists).

- [ ] **Step 5: Commit**

```bash
git add python/guard.py src/tools/python.ts test/python.test.ts
git commit -m "feat: guarded python runner for solver-written code"
git push origin main
```

---

### Task 13: Reasoning Gym tasks and seed harnesses

**Files:**
- Create: `python/rg_bridge.py`, `src/tasks/reasoning-gym/bridge.ts`, `src/tasks/reasoning-gym/task.ts`, `src/tasks/registry.ts`, `seeds/rg-seed.js`, `seeds/tool-loop.js`
- Test: `test/reasoning-gym.test.ts`, `test/seeds.test.ts`

**Interfaces:**
- Consumes: `Task`, `Question`, `CapabilityName` (Task 3); `repoPath`, `defaultPythonPath` (Task 11); `createArithmeticTask` (Task 4).
- Produces: `ReasoningGymBridge` (`generate(family, size, seed, config?)`, `score(family, size, seed, index, answer, config?)`, `families()`, `close()`), `RgEntry`; `createReasoningGymTask(options): Promise<Task>`, `describeFamily(family, doc, config)`; `createTask(spec, options?): Promise<Task>` for `toy:addition` and `rg:<family>`; seed files `seeds/rg-seed.js`, `seeds/tool-loop.js`.

- [ ] **Step 1: Write the failing tests**

**Test: `test/reasoning-gym.test.ts`**
```ts
import { existsSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";

const python = repoPath(".venv", "bin", "python");

describe.skipIf(!existsSync(python))("reasoning gym", () => {
	const bridge = new ReasoningGymBridge({ pythonPath: python });
	afterAll(() => bridge.close());

	test("creates a task with disjoint dev and held-out questions and grades answers", async () => {
		const task = await createReasoningGymTask({ family: "basic_arithmetic", bridge, devSize: 5, heldoutSize: 10 });
		expect(task.name).toBe("rg:basic_arithmetic");
		expect(task.dev).toHaveLength(5);
		expect(task.heldout).toHaveLength(10);
		const devPrompts = new Set(task.dev.map((q) => q.prompt));
		for (const q of task.heldout) expect(devPrompts.has(q.prompt)).toBe(false);
		const q = task.dev[0];
		expect((await task.grade(q, q.answer)).score).toBe(1);
		expect((await task.grade(q, "definitely wrong")).score).toBe(0);
		expect(task.description).toContain("basic_arithmetic");
	});

	test("reports unknown families", async () => {
		await expect(createReasoningGymTask({ family: "no_such_family", bridge, devSize: 1, heldoutSize: 1 })).rejects.toThrow(
			"reasoning_gym",
		);
	});

	test("lists families", async () => {
		expect(await bridge.families()).toContain("maze");
	});
});
```

**Test: `test/seeds.test.ts`**
```ts
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { runHarness } from "../src/core/sandbox.ts";
import { screenHarness } from "../src/core/screens.ts";
import { createTask } from "../src/tasks/registry.ts";
import { stubPython, stubSolver, TOY_INFO } from "./helpers.ts";

const budgets = { ...DEFAULT_BUDGETS, questionTimeoutMs: 5000 };
const seed = (name: string) => readFile(repoPath("seeds", name), "utf8");

describe("seed harnesses", () => {
	test("load and pass screens", async () => {
		for (const name of ["rg-seed.js", "tool-loop.js"]) {
			expect(await screenHarness(await seed(name), { maxLines: 300 })).toEqual({ ok: true });
		}
	});

	test("rg-seed makes one call and extracts the last answer", async () => {
		const solver = stubSolver(() => "Thinking.\nAnswer: wrong\nAnswer: 42");
		const run = await runHarness({ source: await seed("rg-seed.js"), prompt: "q", task: TOY_INFO, capabilities: ["llm"], deps: { solver }, budgets });
		expect(run.answer).toBe("42");
		expect(solver.requests).toHaveLength(1);
	});

	test("tool-loop runs python and then answers", async () => {
		const solver = stubSolver((r) =>
			r.messages.length === 1 ? "```python\nprint(2 + 3)\n```" : `Answer: ${/\d+/.exec(r.messages[r.messages.length - 1].content)?.[0]}`,
		);
		const run = await runHarness({
			source: await seed("tool-loop.js"),
			prompt: "What is 2 + 3?",
			task: TOY_INFO,
			capabilities: ["llm", "python"],
			deps: { solver, python: stubPython() },
			budgets,
		});
		expect(run.answer).toBe("5");
	});
});

describe("createTask", () => {
	test("builds the toy task and rejects unknown specs", async () => {
		expect((await createTask("toy:addition", { devSize: 3, heldoutSize: 2 })).dev).toHaveLength(3);
		await expect(createTask("nope:x")).rejects.toThrow("Unknown task");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/reasoning-gym.test.ts test/seeds.test.ts`
Expected: FAIL, modules and seed files not found.

- [ ] **Step 3: Write the implementation**

**File: `python/rg_bridge.py`**
```python
"""JSON-lines bridge to reasoning_gym: generate questions and score answers.

Requests on stdin, one JSON object per line: {"id", "op": "generate" | "score" | "families", ...}.
Responses on stdout: {"id", "ok": true, ...} or {"id", "ok": false, "error"}.
Library output is redirected to stderr so it cannot corrupt the protocol.
"""

import json
import sys
import traceback
import warnings

warnings.filterwarnings("ignore")
PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

import reasoning_gym  # noqa: E402

_datasets = {}


def _dataset(family, size, seed, config):
    key = (family, size, seed, json.dumps(config or {}, sort_keys=True))
    dataset = _datasets.get(key)
    if dataset is None:
        dataset = reasoning_gym.create_dataset(family, size=size, seed=seed, **(config or {}))
        _datasets[key] = dataset
    return dataset


def _handle(request):
    op = request["op"]
    if op == "generate":
        dataset = _dataset(request["family"], request["size"], request["seed"], request.get("config"))
        entries = []
        for index in range(request["size"]):
            entry = dataset[index]
            answer = entry.get("answer")
            entries.append({
                "index": index,
                "question": entry["question"],
                "answer": "" if answer is None else str(answer),
                "metadata": entry.get("metadata", {}),
            })
        return {"entries": entries, "doc": (type(dataset).__doc__ or "").strip()}
    if op == "score":
        dataset = _dataset(request["family"], request["size"], request["seed"], request.get("config"))
        entry = dataset[request["index"]]
        return {"score": float(dataset.score_answer(request["answer"], entry))}
    if op == "families":
        return {"families": sorted(reasoning_gym.factory.DATASETS.keys())}
    raise ValueError(f"unknown op {op!r}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            response = {"id": request.get("id"), "ok": True, **_handle(request)}
        except Exception as exc:  # noqa: BLE001 - report every failure to the caller
            response = {
                "id": request.get("id"),
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=3),
            }
        PROTOCOL_OUT.write(json.dumps(response, default=str) + "\n")
        PROTOCOL_OUT.flush()


if __name__ == "__main__":
    main()
```

**File: `src/tasks/reasoning-gym/bridge.ts`**
```ts
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { repoPath } from "../../config.ts";

export interface RgEntry {
	index: number;
	question: string;
	answer: string;
	metadata: Record<string, unknown>;
}

export interface BridgeOptions {
	pythonPath: string;
	scriptPath?: string;
	requestTimeoutMs?: number;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** A persistent python/rg_bridge.py process. Restarts on exit or timeout. */
export class ReasoningGymBridge {
	private readonly options: BridgeOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private stderrTail = "";

	constructor(options: BridgeOptions) {
		this.options = options;
	}

	async generate(family: string, size: number, seed: number, config: Record<string, unknown> = {}): Promise<{ entries: RgEntry[]; doc: string }> {
		const response = await this.request({ op: "generate", family, size, seed, config });
		return { entries: response.entries as RgEntry[], doc: String(response.doc ?? "") };
	}

	async score(
		family: string,
		size: number,
		seed: number,
		index: number,
		answer: string,
		config: Record<string, unknown> = {},
	): Promise<number> {
		const response = await this.request({ op: "score", family, size, seed, index, answer, config });
		return Number(response.score);
	}

	async families(): Promise<string[]> {
		return (await this.request({ op: "families" })).families as string[];
	}

	request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		const child = this.ensureStarted();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`reasoning_gym bridge timed out on ${String(payload.op)}`));
				this.restart();
			}, this.options.requestTimeoutMs ?? 120_000);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;
		const script = this.options.scriptPath ?? repoPath("python", "rg_bridge.py");
		const child = spawn(this.options.pythonPath, ["-I", "-B", "-W", "ignore", script], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
		});
		this.child = child;
		createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
		});
		child.stdin.on("error", () => {});
		child.on("exit", (code) => {
			if (this.child === child) this.child = undefined;
			const error = new Error(`reasoning_gym bridge exited with code ${code}: ${this.stderrTail.trim().slice(-800)}`);
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(error);
				this.pending.delete(id);
			}
		});
		return child;
	}

	private onLine(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000);
			return;
		}
		const id = Number(message.id);
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve(message);
		else pending.reject(new Error(`reasoning_gym: ${String(message.error)}`));
	}

	private restart(): void {
		const child = this.child;
		this.child = undefined;
		child?.kill("SIGKILL");
	}
}
```

**File: `src/tasks/reasoning-gym/task.ts`**
```ts
import type { CapabilityName, Question, Task } from "../../core/types.ts";
import type { ReasoningGymBridge, RgEntry } from "./bridge.ts";

export interface ReasoningGymTaskOptions {
	family: string;
	bridge: ReasoningGymBridge;
	devSize?: number;
	heldoutSize?: number;
	devSeed?: number;
	heldoutSeed?: number;
	config?: Record<string, unknown>;
	capabilities?: CapabilityName[];
}

/** One Reasoning Gym family as a task: disjoint dev and held-out questions from different generator seeds. */
export async function createReasoningGymTask(o: ReasoningGymTaskOptions): Promise<Task> {
	const devSize = o.devSize ?? 25;
	const heldoutSize = o.heldoutSize ?? 75;
	const devSeed = o.devSeed ?? 1001;
	const heldoutSeed = o.heldoutSeed ?? 2002;
	const config = o.config ?? {};
	const dev = await o.bridge.generate(o.family, devSize, devSeed, config);
	const poolSize = heldoutSize * 2 + 10;
	const pool = await o.bridge.generate(o.family, poolSize, heldoutSeed, config);
	const seen = new Set(dev.entries.map((e) => e.question));
	const heldoutEntries: RgEntry[] = [];
	for (const entry of pool.entries) {
		if (heldoutEntries.length >= heldoutSize) break;
		if (seen.has(entry.question)) continue;
		seen.add(entry.question);
		heldoutEntries.push(entry);
	}
	const toQuestion =
		(split: "dev" | "heldout", seed: number, size: number) =>
		(entry: RgEntry): Question => ({
			id: `${o.family}/${split}/${entry.index}`,
			prompt: entry.question,
			answer: entry.answer,
			meta: { seed, size, index: entry.index },
		});
	return {
		name: `rg:${o.family}`,
		description: describeFamily(o.family, dev.doc, config),
		capabilities: o.capabilities ?? ["llm", "python"],
		dev: dev.entries.map(toQuestion("dev", devSeed, devSize)),
		heldout: heldoutEntries.map(toQuestion("heldout", heldoutSeed, poolSize)),
		grade: async (question, answer) => {
			const meta = question.meta as { seed: number; size: number; index: number };
			return { score: await o.bridge.score(o.family, meta.size, meta.seed, meta.index, answer, config) };
		},
	};
}

export function describeFamily(family: string, doc: string, config: Record<string, unknown>): string {
	const summary = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
	const configText = Object.keys(config).length > 0 ? ` Generator configuration: ${JSON.stringify(config)}.` : " Default generator configuration.";
	return `Reasoning Gym task family "${family}".${summary ? ` ${summary}` : ""}${configText} Each question states its required answer format; solve() must return only the final answer string. Answers are scored by the family's verifier in [0, 1]; some families give partial credit.`;
}
```

**File: `src/tasks/registry.ts`**
```ts
import { defaultPythonPath } from "../config.ts";
import type { Task } from "../core/types.ts";
import { ReasoningGymBridge } from "./reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "./reasoning-gym/task.ts";
import { createArithmeticTask } from "./toy.ts";

export interface TaskOptions {
	devSize?: number;
	heldoutSize?: number;
	devSeed?: number;
	heldoutSeed?: number;
	/** Shared bridge; when omitted the task owns a bridge and closes it in close(). */
	bridge?: ReasoningGymBridge;
}

/** Builds a task from a spec: `toy:addition` or `rg:<family>`. */
export async function createTask(spec: string, o: TaskOptions = {}): Promise<Task> {
	const colon = spec.indexOf(":");
	const kind = colon < 0 ? spec : spec.slice(0, colon);
	const name = colon < 0 ? "" : spec.slice(colon + 1);
	if (kind === "toy" && name === "addition") {
		return createArithmeticTask({ dev: o.devSize, heldout: o.heldoutSize, seed: o.devSeed });
	}
	if (kind === "rg" && name) {
		const bridge = o.bridge ?? new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
		try {
			const task = await createReasoningGymTask({
				family: name,
				bridge,
				devSize: o.devSize,
				heldoutSize: o.heldoutSize,
				devSeed: o.devSeed,
				heldoutSeed: o.heldoutSeed,
			});
			return o.bridge ? task : { ...task, close: () => bridge.close() };
		} catch (error) {
			if (!o.bridge) await bridge.close();
			throw error;
		}
	}
	throw new Error(`Unknown task "${spec}". Use toy:addition or rg:<family> (list families with \`tta families\`).`);
}
```

**File: `seeds/rg-seed.js`**
```js
// Seed harness (paper App. B.1): one solver call, then extract the final answer.
const SYSTEM = "Solve the problem. End your response with a final line of the form: Answer: <answer>";

async function solve(question) {
	const response = await llm({ system: SYSTEM, prompt: question });
	return extractAnswer(response);
}

function extractAnswer(text) {
	const marker = /answer\s*:\s*/gi;
	let start = -1;
	let match = marker.exec(text);
	while (match !== null) {
		start = match.index + match[0].length;
		match = marker.exec(text);
	}
	return (start >= 0 ? text.slice(start) : text).trim();
}
```

**File: `seeds/tool-loop.js`**
```js
// Fixed tool-loop baseline (paper App. B.1): the solver may run Python for up to five turns.
const SYSTEM = [
	"You solve problems and may run Python 3 code to help.",
	"To run code, reply with exactly one ```python code block and nothing after it; you will receive its output.",
	"When you are done, reply with a final line of the form: Answer: <answer>",
].join("\n");
const MAX_TURNS = 5;

async function solve(question) {
	const messages = [{ role: "user", content: question }];
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const reply = await llm({ system: SYSTEM, messages });
		messages.push({ role: "assistant", content: reply });
		const code = extractCode(reply);
		if (code === null) return extractAnswer(reply);
		const result = await python(code, { timeoutMs: 10000 });
		const output = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.slice(0, 4000);
		messages.push({ role: "user", content: `Output:\n${output || "(no output)"}` });
	}
	messages.push({ role: "user", content: "Give your final answer now, as a final line of the form: Answer: <answer>" });
	return extractAnswer(await llm({ system: SYSTEM, messages }));
}

function extractCode(text) {
	const match = /```(?:python|py)?[ \t]*\n([\s\S]*?)```/i.exec(text);
	if (!match) return null;
	if (/answer\s*:/i.test(text.slice(match.index + match[0].length))) return null;
	return match[1];
}

function extractAnswer(text) {
	const marker = /answer\s*:\s*/gi;
	let start = -1;
	let match = marker.exec(text);
	while (match !== null) {
		start = match.index + match[0].length;
		match = marker.exec(text);
	}
	return (start >= 0 ? text.slice(start) : text).trim();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/reasoning-gym.test.ts test/seeds.test.ts && npm test && npm run check`
Expected: all pass (Reasoning Gym tests run when `.venv` exists).

- [ ] **Step 5: Commit**

```bash
git add python/rg_bridge.py src/tasks/reasoning-gym src/tasks/registry.ts seeds test/reasoning-gym.test.ts test/seeds.test.ts
git commit -m "feat: Reasoning Gym tasks through a python bridge; seed and tool-loop harnesses"
git push origin main
```

---

### Task 14: CLI

**Files:**
- Create: `src/cli.ts`
- Modify: `README.md` (usage section)

**Interfaces:**
- Consumes: `createTask`, `adapt`, `independentRevisions`, `evaluateHarness`, Bedrock clients, `createPythonRunner`, `ReasoningGymBridge`.
- Produces: `node src/cli.ts adapt|independent|eval|families` (also `npm run tta -- ...`).

- [ ] **Step 1: Write the CLI**

**File: `src/cli.ts`**
```ts
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "./config.ts";
import { type Budgets, DEFAULT_BUDGETS } from "./core/capabilities.ts";
import { evaluateHarness } from "./core/executor.ts";
import { independentRevisions } from "./core/independent.ts";
import { type AdaptConfig, adapt, QA_PROTOCOL, REASONING_GYM_PROTOCOL, renderUsage } from "./core/loop.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "./llm/pi-clients.ts";
import { ReasoningGymBridge } from "./tasks/reasoning-gym/bridge.ts";
import { createTask } from "./tasks/registry.ts";
import { createPythonRunner } from "./tools/python.ts";
import { Semaphore } from "./util/concurrency.ts";
import { fmt } from "./util/text.ts";

const HELP = `tta: test-time harness adaptation on pi

Usage:
  tta adapt --task <spec> [options]        Run the adaptation loop (paper Eq. 4)
  tta independent --task <spec> [options]  Sample independent single-step revisions of the seed
  tta eval --task <spec> --harness <file>  Score a harness on dev and held-out questions
  tta families                             List Reasoning Gym families

Task specs: toy:addition, rg:<family>

Options:
  --seed-harness <file>      Seed harness (default seeds/rg-seed.js)
  --harness <file>           Harness to score (eval)
  --set dev|heldout|both     Question sets to score (eval, default both)
  --solver <id>              Bedrock solver model (default $TTA_SOLVER_MODEL or ${DEFAULT_SOLVER_MODEL})
  --proposer <id>            Bedrock proposer model (default $TTA_PROPOSER_MODEL or ${DEFAULT_PROPOSER_MODEL})
  --reasoning <level>        Proposer thinking: off|minimal|low|medium|high (default medium)
  --protocol rg|qa           Selection protocol preset (default rg)
  --rounds <n>               Revision rounds T
  --proposals <n>            Proposals per round G
  --feedback <n|all>         Feedback questions per round
  --scoring <n|all>          Scoring questions per round
  --attempts <n>             Generation attempts per proposal
  --max-lines <n>            Harness line limit
  --dev <n> --heldout <n>    Question pool sizes
  --concurrency <n>          Questions in parallel per evaluation (default 8)
  --solver-concurrency <n>   Concurrent solver requests (default 16)
  --llm-calls <n>            Solver calls per question (default ${DEFAULT_BUDGETS.llmCalls})
  --question-timeout <s>     Seconds per question (default ${DEFAULT_BUDGETS.questionTimeoutMs / 1000})
  --temperature <t>          Default solver temperature (default 0.7)
  --branch-hints             Diversify parallel proposals
  --no-heldout               Skip held-out evaluation
  --run-dir <dir>            Artifact directory (default runs/<time>-<command>-<task>)
  --seed <n>                 Sampling seed (default 1)

Credentials come from the AWS credential chain (set AWS_PROFILE). AWS_REGION defaults to us-east-1.
`;

const OPTIONS = {
	task: { type: "string" },
	"seed-harness": { type: "string" },
	harness: { type: "string" },
	set: { type: "string" },
	solver: { type: "string" },
	proposer: { type: "string" },
	reasoning: { type: "string" },
	protocol: { type: "string" },
	rounds: { type: "string" },
	proposals: { type: "string" },
	feedback: { type: "string" },
	scoring: { type: "string" },
	attempts: { type: "string" },
	"max-lines": { type: "string" },
	dev: { type: "string" },
	heldout: { type: "string" },
	concurrency: { type: "string" },
	"solver-concurrency": { type: "string" },
	"llm-calls": { type: "string" },
	"question-timeout": { type: "string" },
	temperature: { type: "string" },
	"branch-hints": { type: "boolean" },
	"no-heldout": { type: "boolean" },
	"run-dir": { type: "string" },
	seed: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

function log(line: string): void {
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

function integer(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got "${value}"`);
	return n;
}

function optionalInteger(value: string | undefined): number | undefined {
	return value === undefined ? undefined : integer(value, 0);
}

function sizeOrAll(value: string | undefined, fallback: number | "all"): number | "all" {
	return value === undefined ? fallback : value === "all" ? "all" : integer(value, 0);
}

function reasoningLevel(value: string | undefined): ThinkingLevel | undefined {
	if (value === undefined) return "medium";
	if (value === "off") return undefined;
	return value as ThinkingLevel;
}

function defaultRunDir(command: string, spec: string): string {
	const time = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return repoPath("runs", `${time}-${command}-${spec.replace(/[^\w]+/g, "_")}`);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
	const command = positionals[0];
	if (!command || values.help) {
		process.stdout.write(HELP);
		return;
	}
	process.env.AWS_REGION ??= "us-east-1";
	if (command === "families") {
		const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
		try {
			process.stdout.write(`${(await bridge.families()).join("\n")}\n`);
		} finally {
			await bridge.close();
		}
		return;
	}
	if (!["adapt", "independent", "eval"].includes(command)) throw new Error(`Unknown command "${command}". Run tta --help.`);
	const spec = values.task;
	if (!spec) throw new Error("--task is required");

	const task = await createTask(spec, { devSize: optionalInteger(values.dev), heldoutSize: optionalInteger(values.heldout) });
	try {
		const models = createBedrockModels();
		const solverModel = requireModel(models, values.solver ?? process.env.TTA_SOLVER_MODEL ?? DEFAULT_SOLVER_MODEL);
		const solver = new PiSolverClient({
			models,
			model: solverModel,
			limiter: new Semaphore(integer(values["solver-concurrency"], 16)),
			temperature: values.temperature === undefined ? 0.7 : Number(values.temperature),
			onRetry: (attempt, message) => log(`solver retry ${attempt}: ${message.slice(0, 160)}`),
		});
		const python = createPythonRunner({ pythonPath: defaultPythonPath() });
		const budgets: Budgets = {
			...DEFAULT_BUDGETS,
			llmCalls: integer(values["llm-calls"], DEFAULT_BUDGETS.llmCalls),
			questionTimeoutMs: integer(values["question-timeout"], DEFAULT_BUDGETS.questionTimeoutMs / 1000) * 1000,
		};
		const concurrency = integer(values.concurrency, 8);
		log(`task ${task.name}: ${task.dev.length} dev / ${task.heldout.length} held-out; solver ${solverModel.id}; AWS profile ${process.env.AWS_PROFILE ?? "(default chain)"}`);

		if (command === "eval") {
			if (!values.harness) throw new Error("--harness is required for eval");
			const source = await readFile(values.harness, "utf8");
			const sets = values.set ?? "both";
			for (const [name, questions] of [
				["dev", task.dev],
				["heldout", task.heldout],
			] as const) {
				if (sets !== "both" && sets !== name) continue;
				const result = await evaluateHarness({ task, source, questions, label: name, deps: { solver, python, search: task.search }, budgets, concurrency });
				const counts = Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(", ");
				process.stdout.write(`${name}: ${fmt(result.mean)} on ${questions.length} (${counts}); ${result.calls.llm} solver calls, $${result.usage.cost.toFixed(4)}\n`);
			}
			return;
		}

		const proposerModel = requireModel(models, values.proposer ?? process.env.TTA_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL);
		const proposer = new PiProposerClient({
			models,
			model: proposerModel,
			reasoning: reasoningLevel(values.reasoning),
			onRetry: (attempt, message) => log(`proposer retry ${attempt}: ${message.slice(0, 160)}`),
		});
		const seedSource = await readFile(values["seed-harness"] ?? repoPath("seeds", "rg-seed.js"), "utf8");
		const runDir = values["run-dir"] ?? defaultRunDir(command, spec);
		const preset = values.protocol === "qa" ? QA_PROTOCOL : REASONING_GYM_PROTOCOL;
		const seed = integer(values.seed, 1);
		log(`proposer ${proposerModel.id}; artifacts in ${runDir}`);

		if (command === "independent") {
			const summary = await independentRevisions({
				task,
				seedSource,
				proposals: integer(values.proposals, 8),
				deps: { solver, proposer, python },
				config: {
					budgets,
					concurrency,
					attempts: integer(values.attempts, preset.attempts),
					maxLines: integer(values["max-lines"], preset.maxLines),
					seed,
					branchHints: values["branch-hints"] ?? true,
					feedbackSize: sizeOrAll(values.feedback, preset.feedbackSize),
				},
				runDir,
				log,
			});
			process.stdout.write(
				`${task.name}: seed held-out ${fmt(summary.seedHeldout)}; ${summary.proposals.length} proposals mean ${fmt(summary.mean)}, best ${fmt(summary.bestOf)}, failed ${fmt(summary.failedRate * 100, 1)}%\n${renderUsage("Solver", summary.usage.solver)}\n${renderUsage("Proposer", summary.usage.proposer)}\n`,
			);
			return;
		}

		const config: AdaptConfig = {
			...preset,
			rounds: integer(values.rounds, preset.rounds),
			proposals: integer(values.proposals, preset.proposals),
			feedbackSize: sizeOrAll(values.feedback, preset.feedbackSize),
			scoringSize: sizeOrAll(values.scoring, preset.scoringSize),
			attempts: integer(values.attempts, preset.attempts),
			maxLines: integer(values["max-lines"], preset.maxLines),
			evaluateHeldout: !values["no-heldout"],
			branchHints: values["branch-hints"] ?? preset.branchHints,
			budgets,
			concurrency,
			seed,
		};
		const summary = await adapt({ task, seedSource, config, deps: { solver, proposer, python }, runDir, log });
		const lines = summary.rounds.map(
			(r) => `round ${r.round}: ${r.selection.reason}; held-out ${r.heldout === undefined ? "-" : fmt(r.heldout)}`,
		);
		process.stdout.write(
			`${[`${task.name}: held-out seed ${summary.seedHeldout === undefined ? "-" : fmt(summary.seedHeldout)}`, ...lines, renderUsage("Solver", summary.usage.solver), renderUsage("Proposer", summary.usage.proposer), `artifacts: ${runDir}`].join("\n")}\n`,
		);
	} finally {
		await task.close?.();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
```

- [ ] **Step 2: Check and smoke-test offline**

Run: `npm run check && node src/cli.ts --help && node src/cli.ts families | head -3`
Expected: help text; first three family names.

- [ ] **Step 3: Live smoke test on the toy task**

Run:
```bash
export AWS_PROFILE=<aws-profile>
node src/cli.ts eval --task toy:addition --harness seeds/rg-seed.js --solver us.amazon.nova-micro-v1:0 --dev 10 --heldout 10
node src/cli.ts adapt --task toy:addition --rounds 1 --dev 8 --heldout 8 --solver us.amazon.nova-micro-v1:0 --reasoning low
```
Expected: eval prints scores; adapt completes one round and writes `runs/<…>/summary.md`.

- [ ] **Step 4: Document usage in README and commit**

Add a "Usage" section to `README.md` with the commands above and the artifact layout (`config.json`, `seed.js`, `round-00/heldout.*`, `round-NN/{feedback.*, report.md, candidates/cK/{transcript.md, proposal.json, harness.js, score.*}, selected.js, heldout.*, round.json}`, `state.json`, `final.js`, `summary.{json,md}`).

```bash
git add src/cli.ts README.md
git commit -m "feat: tta CLI for adapt, independent, eval, families"
git push origin main
```

---

### Task 15: End-to-end Reasoning Gym runs on Bedrock

**Files:**
- Create: `experiments/calibrate.ts`, `experiments/rg-suite.ts`, `results/calibration.md`, `results/reasoning-gym-multistep.md`
- Modify: `src/config.ts` (`DEFAULT_SOLVER_MODEL` from calibration), `README.md` (results summary)

**Interfaces:**
- Consumes: `createReasoningGymTask`, `ReasoningGymBridge`, `evaluateHarness`, `adapt`, Bedrock clients.
- Produces: committed result tables.

- [ ] **Step 1: Write the calibration script**

**File: `experiments/calibrate.ts`**
```ts
// Seed and tool-loop development scores per solver model and Reasoning Gym family.
// Usage: AWS_PROFILE=... node experiments/calibrate.ts --solvers a,b --families maze,count_primes --dev 20 --out results/calibration.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { defaultPythonPath, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { evaluateHarness } from "../src/core/executor.ts";
import { createBedrockModels, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";
import { createPythonRunner } from "../src/tools/python.ts";
import { Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: { solvers: { type: "string" }, families: { type: "string" }, dev: { type: "string" }, out: { type: "string" } },
});
process.env.AWS_REGION ??= "us-east-1";
const solvers = (values.solvers ?? "us.meta.llama3-1-8b-instruct-v1:0").split(",");
const families = (values.families ?? "maze,count_primes").split(",");
const devSize = Number(values.dev ?? 20);
const seeds = { seed: await readFile(repoPath("seeds", "rg-seed.js"), "utf8"), "tool-loop": await readFile(repoPath("seeds", "tool-loop.js"), "utf8") };
const models = createBedrockModels();
const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
const python = createPythonRunner({ pythonPath: defaultPythonPath() });
const limiter = new Semaphore(16);
const rows: string[] = [];
try {
	for (const family of families) {
		const task = await createReasoningGymTask({ family, bridge, devSize, heldoutSize: 0 });
		for (const id of solvers) {
			const solver = new PiSolverClient({ models, model: requireModel(models, id), limiter, temperature: 0.7 });
			const scores: string[] = [];
			let cost = 0;
			for (const [name, source] of Object.entries(seeds)) {
				const result = await evaluateHarness({ task, source, questions: task.dev, label: name, deps: { solver, python }, budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 180_000 }, concurrency: 8 });
				scores.push(fmt(result.mean));
				cost += result.usage.cost;
			}
			rows.push(`| ${family} | ${id} | ${scores.join(" | ")} | $${cost.toFixed(4)} |`);
			process.stderr.write(`${rows[rows.length - 1]}\n`);
		}
	}
} finally {
	await bridge.close();
}
const table = [`# Solver calibration (${devSize} dev questions per family)`, "", "| Family | Solver | Seed | Tool loop | Cost |", "|---|---|---|---|---|", ...rows, ""].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
```

- [ ] **Step 2: Run calibration and choose the solver**

Run:
```bash
export AWS_PROFILE=<aws-profile>
node experiments/calibrate.ts --solvers us.meta.llama3-1-8b-instruct-v1:0,us.amazon.nova-micro-v1:0,qwen.qwen3-32b-v1:0 --families maze,count_primes,caesar_cipher,sudoku,group_anagrams,palindrome_partitioning --dev 20 --out results/calibration.md
```
Choose the solver whose seed scores leave room to improve (mostly below 0.6) while the tool-loop baseline shows that it can use code (above the seed on several families). Set `DEFAULT_SOLVER_MODEL` in `src/config.ts` to it.

- [ ] **Step 3: Write the multistep suite script**

**File: `experiments/rg-suite.ts`**
```ts
// Runs the Reasoning Gym protocol (T rounds, G=1, retain if dev improves) on several families.
// Usage: AWS_PROFILE=... node experiments/rg-suite.ts --families maze,count_primes --rounds 5 --out results/reasoning-gym-multistep.md
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROPOSER_MODEL, DEFAULT_SOLVER_MODEL, defaultPythonPath, repoPath } from "../src/config.ts";
import { DEFAULT_BUDGETS } from "../src/core/capabilities.ts";
import { type AdaptSummary, adapt, REASONING_GYM_PROTOCOL } from "../src/core/loop.ts";
import { createBedrockModels, PiProposerClient, PiSolverClient, requireModel } from "../src/llm/pi-clients.ts";
import { ReasoningGymBridge } from "../src/tasks/reasoning-gym/bridge.ts";
import { createReasoningGymTask } from "../src/tasks/reasoning-gym/task.ts";
import { createPythonRunner } from "../src/tools/python.ts";
import { mapLimit, Semaphore } from "../src/util/concurrency.ts";
import { fmt } from "../src/util/text.ts";

const { values } = parseArgs({
	options: {
		families: { type: "string" },
		solver: { type: "string" },
		proposer: { type: "string" },
		reasoning: { type: "string" },
		rounds: { type: "string" },
		dev: { type: "string" },
		heldout: { type: "string" },
		parallel: { type: "string" },
		tag: { type: "string" },
		out: { type: "string" },
	},
});
process.env.AWS_REGION ??= "us-east-1";
const families = (values.families ?? "maze").split(",");
const rounds = Number(values.rounds ?? REASONING_GYM_PROTOCOL.rounds);
const tag = values.tag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const models = createBedrockModels();
const solverId = values.solver ?? DEFAULT_SOLVER_MODEL;
const proposerId = values.proposer ?? DEFAULT_PROPOSER_MODEL;
const solver = new PiSolverClient({ models, model: requireModel(models, solverId), limiter: new Semaphore(24), temperature: 0.7 });
const proposer = new PiProposerClient({ models, model: requireModel(models, proposerId), reasoning: (values.reasoning ?? "medium") as "medium" });
const python = createPythonRunner({ pythonPath: defaultPythonPath(), maxConcurrent: 12 });
const bridge = new ReasoningGymBridge({ pythonPath: defaultPythonPath() });
const seedSource = await readFile(repoPath("seeds", "rg-seed.js"), "utf8");

const summaries = await mapLimit(families, Number(values.parallel ?? 2), async (family): Promise<AdaptSummary | undefined> => {
	try {
		const task = await createReasoningGymTask({ family, bridge, devSize: Number(values.dev ?? 25), heldoutSize: Number(values.heldout ?? 75) });
		return await adapt({
			task,
			seedSource,
			config: { ...REASONING_GYM_PROTOCOL, rounds, budgets: { ...DEFAULT_BUDGETS, questionTimeoutMs: 180_000 }, concurrency: 8, seed: 1 },
			deps: { solver, proposer, python },
			runDir: repoPath("runs", `${tag}-rg-${family}`),
			log: (line) => process.stderr.write(`[${family}] ${line}\n`),
		});
	} catch (error) {
		process.stderr.write(`[${family}] failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return undefined;
	}
});
await bridge.close();

const header = ["Family", "Seed", ...Array.from({ length: rounds }, (_, i) => `R${i + 1}`), "Δ", "Proposer $", "Solver $"];
const rows: string[] = [];
const finals: number[] = [];
const seeds: number[] = [];
summaries.forEach((s, i) => {
	if (!s || s.seedHeldout === undefined || s.finalHeldout === undefined) {
		rows.push(`| ${families[i]} | failed |`);
		return;
	}
	seeds.push(s.seedHeldout);
	finals.push(s.finalHeldout);
	const perRound = s.rounds.map((r) => (r.heldout === undefined ? "–" : fmt(r.heldout, 2)));
	rows.push(
		`| ${families[i]} | ${fmt(s.seedHeldout, 2)} | ${perRound.join(" | ")} | ${fmt(s.finalHeldout - s.seedHeldout, 2)} | ${s.usage.proposer.cost.toFixed(2)} | ${s.usage.solver.cost.toFixed(2)} |`,
	);
});
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const table = [
	`# Reasoning Gym multistep adaptation (${tag})`,
	"",
	`Solver ${solverId}, proposer ${proposerId}. Protocol: ${rounds} rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.`,
	"",
	`| ${header.join(" | ")} |`,
	`|${header.map(() => "---").join("|")}|`,
	...rows,
	"",
	`Mean held-out: seed ${fmt(mean(seeds), 3)} -> final ${fmt(mean(finals), 3)} over ${finals.length} families.`,
	"",
].join("\n");
if (values.out) {
	await mkdir(dirname(values.out), { recursive: true });
	await writeFile(values.out, table);
}
process.stdout.write(table);
```

- [ ] **Step 4: Run the suite**

Run:
```bash
export AWS_PROFILE=<aws-profile>
node experiments/rg-suite.ts --families maze,count_primes,caesar_cipher,sudoku,group_anagrams,palindrome_partitioning,rotten_oranges,word_ladder --rounds 5 --out results/reasoning-gym-multistep.md
```
Expected: a table with held-out per round; most families improve over the seed. Inspect two runs' `report.md` and transcripts for correctness of the feedback (failures shown, no held-out text).

- [ ] **Step 5: Commit results**

```bash
git add experiments/calibrate.ts experiments/rg-suite.ts results/calibration.md results/reasoning-gym-multistep.md src/config.ts README.md
git commit -m "feat: Reasoning Gym end-to-end adaptation results on Bedrock"
git push origin main
```

---

## Follow-up plans

- Plan 2: multi-hop QA (HotpotQA, MuSiQue, 2Wiki; BM25; QA seed of Fig. 12a; best-of-G protocol).
- Plan 3: agentic proposer on the pi coding-agent SDK; pi package with `/adapt` and `adapt_harness`.
- Plan 4: outer-loop extras (rollout and SFT export, revision-memory transfer).
