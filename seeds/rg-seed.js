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
