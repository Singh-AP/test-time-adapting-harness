import { expect, test } from "vitest";
import { defaultSeedFile } from "../src/config.ts";

test("QA tasks default to the QA seed, other tasks to the Reasoning Gym seed", () => {
	expect(defaultSeedFile("qa:musique")).toMatch(/seeds\/qa-seed\.js$/);
	expect(defaultSeedFile("rg:maze")).toMatch(/seeds\/rg-seed\.js$/);
	expect(defaultSeedFile("toy:addition")).toMatch(/seeds\/rg-seed\.js$/);
});
