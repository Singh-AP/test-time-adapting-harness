// Seed QA harness (paper Fig. 12a): two-hop retrieve-and-summarize.
const K = 5;
const SUMMARIZE = "You extract facts from passages. Be concise and factual.";
const ANSWER = "You answer multi-hop questions from given facts.";

function formatPassages(passages) {
	return passages.map((p, i) => `[${i + 1}] ${p.title}: ${p.text}`).join("\n");
}

async function summarize(question, passages) {
	return await llm({
		system: SUMMARIZE,
		prompt: `Question: ${question}\n\nPassages:\n${formatPassages(passages)}\n\nSummarize the facts in these passages that help answer the question.`,
		maxTokens: 400,
	});
}

async function solve(question) {
	const first = await search(question, K);
	const summary1 = await summarize(question, first);
	const query = await llm({
		system: SUMMARIZE,
		prompt: `Question: ${question}\n\nKnown facts:\n${summary1}\n\nWrite one search query for the missing information needed to answer the question. Reply with the search query only.`,
		maxTokens: 60,
	});
	const second = await search(query.split("\n")[0].replace(/^["']|["']$/g, ""), K);
	const summary2 = await summarize(question, second);
	const reply = await llm({
		system: ANSWER,
		prompt: `Question: ${question}\n\nFacts:\n${summary1}\n${summary2}\n\nAnswer the question with a short span (an entity, date, number, or yes/no). Reply in the form: Answer: <answer>`,
		maxTokens: 60,
	});
	const marker = reply.toLowerCase().lastIndexOf("answer:");
	return (marker >= 0 ? reply.slice(marker + "answer:".length) : reply).trim().replace(/\.$/, "");
}
