import { createHash } from "node:crypto";

/** Short content hash used to identify harness versions. */
export function hashSource(source: string): string {
	return createHash("sha256").update(source).digest("hex").slice(0, 12);
}
