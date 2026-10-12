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
		await this.writeJson(`${relative}.json`, {
			...result,
			outcomes: result.outcomes.map((o) => ({ ...o, trace: undefined })),
		});
		const lines = result.outcomes.map((o) => JSON.stringify({ questionId: o.questionId, trace: o.trace }));
		await this.writeText(`${relative}.traces.jsonl`, `${lines.join("\n")}\n`);
	}
}
