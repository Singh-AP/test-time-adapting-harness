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
