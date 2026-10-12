"""Convert a multi-hop QA dev split to JSONL corpus and question files.

Usage: python -I prepare_qa.py <hotpotqa|musique|2wiki> <input.parquet|input.jsonl> <output_dir>

Writes <output_dir>/corpus.jsonl ({"id", "title", "text"}) with every support and distractor paragraph of the
split, deduplicated by (title, text), and <output_dir>/questions.jsonl ({"id", "question", "answer", "aliases",
"supporting_titles", "type"}).
"""

import json
import os
import re
import sys


def _rows(path):
    if path.endswith(".jsonl"):
        with open(path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]
    import pyarrow.parquet as pq

    return pq.read_table(path).to_pylist()


def _context_paragraphs(row):
    context = row["context"]
    return [(title, " ".join(s.strip() for s in sentences)) for title, sentences in zip(context["title"], context["sentences"])]


def _convert(dataset, row):
    if dataset in ("hotpotqa", "2wiki"):
        paragraphs = _context_paragraphs(row)
        supporting = list(dict.fromkeys(row["supporting_facts"]["title"]))
        record = {"id": row["id"], "question": row["question"], "answer": row["answer"], "aliases": [], "supporting_titles": supporting, "type": row["type"]}
        return paragraphs, record
    if dataset == "musique":
        paragraphs = [(p["title"], p["paragraph_text"]) for p in row["paragraphs"]]
        supporting = list(dict.fromkeys(p["title"] for p in row["paragraphs"] if p["is_supporting"]))
        hops = re.match(r"(\d)hop", row["id"])
        record = {
            "id": row["id"],
            "question": row["question"],
            "answer": row["answer"],
            "aliases": list(row.get("answer_aliases") or []),
            "supporting_titles": supporting,
            "type": f"{hops.group(1)}hop" if hops else "unknown",
        }
        return paragraphs, record
    raise ValueError(f"unknown dataset {dataset!r}")


def main():
    dataset, source, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    seen = {}
    questions = []
    for row in _rows(source):
        if dataset == "musique" and row.get("answerable") is False:
            continue
        paragraphs, record = _convert(dataset, row)
        for title, text in paragraphs:
            seen.setdefault((title, text), f"p{len(seen)}")
        questions.append(record)
    with open(os.path.join(out_dir, "corpus.jsonl"), "w", encoding="utf-8") as handle:
        for (title, text), pid in seen.items():
            handle.write(json.dumps({"id": pid, "title": title, "text": text}, ensure_ascii=False) + "\n")
    with open(os.path.join(out_dir, "questions.jsonl"), "w", encoding="utf-8") as handle:
        for record in questions:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"{dataset}: {len(questions)} questions, {len(seen)} paragraphs -> {out_dir}")


if __name__ == "__main__":
    main()
