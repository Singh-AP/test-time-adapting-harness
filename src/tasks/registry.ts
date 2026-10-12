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
