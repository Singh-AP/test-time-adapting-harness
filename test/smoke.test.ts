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
