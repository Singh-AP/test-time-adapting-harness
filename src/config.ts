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

/** Seed harness for a task spec: the two-hop retrieval seed for QA tasks, the one-call seed otherwise. */
export function defaultSeedFile(taskName: string): string {
	return repoPath("seeds", taskName.startsWith("qa:") ? "qa-seed.js" : "rg-seed.js");
}

export const DEFAULT_PROPOSER_MODEL = "us.anthropic.claude-opus-5-5";
export const DEFAULT_SOLVER_MODEL = "qwen.qwen3-32b-v1:0";
