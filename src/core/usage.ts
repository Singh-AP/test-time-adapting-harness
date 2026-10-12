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
