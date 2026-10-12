# test-time-adapting-harness

An agent harness that adapts itself at test time, following *Harness Learning Enables Generalizable
Test-Time Adaptation* (Zhang et al., arXiv:2609.35738), built on the [pi](https://github.com/earendil-works/pi)
agent toolkit.

A *harness* is the program that organizes calls to a frozen solver model, tool use and information flow. A
*proposer* model reads the task description, the current harness and an execution report, and edits the
harness. Repeating this on development questions adapts the harness to a new task without changing any model
weights (paper Eq. 4):

```
for t = 1..T:
    report_t   = run h_{t-1} on feedback questions Q_fb, summarize traces and failures
    y_i        ~ proposer(task, h_{t-1}, report_t)          i = 1..G   (SEARCH/REPLACE edits)
    h'_i       = Apply(h_{t-1}, y_i)                        (invalid if edits do not apply or fail screens)
    h_t        = Select(h_{t-1}, {h'_i}; Q_score)           (greedy-improve or best-of-G)
    report J(h_t; Q_eval) on held-out questions             (never shown to the proposer)
```

How it uses pi:

- Harnesses are JavaScript programs run in **pi-codemode**'s QuickJS sandbox, one fresh VM per question. Their
  only capabilities are host-injected functions with per-question budgets and full tracing: `llm()` (the frozen
  solver), `python()` (guarded subprocess), `search()` (retrieval tasks), `log()`.
- Solver and proposer models are **pi-ai** models (Amazon Bedrock provider; any pi-ai provider works).

Status: core engine, Bedrock clients, Reasoning Gym tasks and the CLI are implemented. Multi-hop QA, an
agentic proposer on the pi coding-agent SDK, and a pi package with an `/adapt` command are next (see
`docs/superpowers/`).

## Setup

    npm install --ignore-scripts
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python reasoning-gym==0.1.19

Credentials come from the AWS credential chain, so set `AWS_PROFILE` (and optionally `AWS_REGION`, default
`us-east-1`). If session credentials expire during a long run, Bedrock calls pause and resume once the
credentials file is refreshed.

## Usage

    # Score a harness
    node src/cli.ts eval --task rg:maze --harness seeds/rg-seed.js --solver us.meta.llama3-1-8b-instruct-v1:0

    # Test-time adaptation, Reasoning Gym protocol (5 rounds, one proposal, keep only improvements)
    node src/cli.ts adapt --task rg:maze --rounds 5 --proposer us.anthropic.claude-opus-5-5

    # Multi-hop QA protocol preset (best-of-G, disjoint feedback/scoring questions)
    node src/cli.ts adapt --task <spec> --protocol qa --rounds 10 --proposals 8

    # Single-step: eight independent proposals from the seed, scored on held-out questions
    node src/cli.ts independent --task rg:maze --proposals 8

    node src/cli.ts families      # Reasoning Gym families
    node src/cli.ts --help        # all options

Task specs: `toy:addition` (offline smoke task) and `rg:<family>` (any Reasoning Gym family; development and
held-out questions come from disjoint generator seeds).

Every run writes `runs/<id>/`:

| Path | Content |
|---|---|
| `config.json`, `seed.js` | task, protocol configuration, seed harness |
| `round-00/heldout.*` | seed held-out evaluation |
| `round-NN/feedback.*`, `report.md` | parent evaluation on Q_fb and the execution report given to the proposer |
| `round-NN/candidates/cK/` | `transcript.md` (prompts and responses), `proposal.json`, `harness.js`, `score.*` |
| `round-NN/selected.js`, `heldout.*`, `round.json` | retained harness, its held-out score, round summary |
| `state.json` | resume point (rerun the same command with `--run-dir` to continue) |
| `final.js`, `summary.{json,md}` | adapted harness and per-round results with token usage and cost |

`*.json` evaluations hold per-question outcomes; `*.traces.jsonl` hold every solver, python and search call.

## Writing a harness

```js
// Available globals: TASK, llm(), python(), search(), log(). No other I/O exists.
async function solve(question) {
	const reply = await llm({ system: "Solve the problem. End with: Answer: <answer>", prompt: question });
	return reply.split(/answer\s*:/i).pop().trim();
}
```

`llm(request)` takes a prompt string or `{system, prompt, messages, temperature, maxTokens}` and returns the
solver's text. `python(code, {timeoutMs, stdin})` returns `{stdout, stderr, exitCode, timedOut}`.

## Safety

Proposer-written harness code runs only inside QuickJS (no filesystem, network, process or timers). Solver-written
Python runs through `python/guard.py`: scrubbed environment (no AWS variables), temp working directory, resource
limits, and an audit hook that blocks sockets, subprocesses, native library loading and file access outside the
scratch directory and the Python installation. This is defense in depth, not a security boundary; use a container
for untrusted settings.

## Test

    npm test
    npm run check
