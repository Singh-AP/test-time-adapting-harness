"""JSON-lines bridge to reasoning_gym: generate questions and score answers.

Requests on stdin, one JSON object per line: {"id", "op": "generate" | "score" | "families", ...}.
Responses on stdout: {"id", "ok": true, ...} or {"id", "ok": false, "error"}.
Library output is redirected to stderr so it cannot corrupt the protocol.
"""

import json
import sys
import traceback
import warnings

warnings.filterwarnings("ignore")
PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

import reasoning_gym  # noqa: E402

_datasets = {}


def _dataset(family, size, seed, config):
    key = (family, size, seed, json.dumps(config or {}, sort_keys=True))
    dataset = _datasets.get(key)
    if dataset is None:
        dataset = reasoning_gym.create_dataset(family, size=size, seed=seed, **(config or {}))
        _datasets[key] = dataset
    return dataset


def _handle(request):
    op = request["op"]
    if op == "generate":
        dataset = _dataset(request["family"], request["size"], request["seed"], request.get("config"))
        entries = []
        for index in range(request["size"]):
            entry = dataset[index]
            answer = entry.get("answer")
            entries.append({
                "index": index,
                "question": entry["question"],
                "answer": "" if answer is None else str(answer),
                "metadata": entry.get("metadata", {}),
            })
        return {"entries": entries, "doc": (type(dataset).__doc__ or "").strip()}
    if op == "score":
        dataset = _dataset(request["family"], request["size"], request["seed"], request.get("config"))
        entry = dataset[request["index"]]
        return {"score": float(dataset.score_answer(request["answer"], entry))}
    if op == "families":
        return {"families": sorted(reasoning_gym.factory.DATASETS.keys())}
    raise ValueError(f"unknown op {op!r}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            response = {"id": request.get("id"), "ok": True, **_handle(request)}
        except Exception as exc:  # noqa: BLE001 - report every failure to the caller
            response = {
                "id": request.get("id"),
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=3),
            }
        PROTOCOL_OUT.write(json.dumps(response, default=str) + "\n")
        PROTOCOL_OUT.flush()


if __name__ == "__main__":
    main()
