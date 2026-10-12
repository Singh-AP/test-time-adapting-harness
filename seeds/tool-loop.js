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
