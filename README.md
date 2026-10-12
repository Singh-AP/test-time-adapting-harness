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

Components:

- **Engine** (`src/core`): sandboxed harness execution, execution reports, SEARCH/REPLACE edits, static screens,
  greedy and best-of-G selection, the Eq. 4 loop with artifacts and resume, single-step evaluation, Eq. 8/11
  rewards and GRPO group advantages.
- **Proposers**: a single-shot prompt proposer (paper-faithful), and an **agentic proposer** that is a pi
  coding-agent session editing `harness.js` in a scratch workspace with `check_harness` and `run_feedback`
  tools (paper App. F future work).
- **Tasks**: Reasoning Gym families (real `reasoning_gym` generators and verifiers) and multi-hop QA (HotpotQA,
  MuSiQue, 2WikiMultihopQA) over pooled paragraph corpora with BM25.
- **pi package**: `adapt_harness` tool, `/adapt` and `/harness-runs` commands, so pi itself runs test-time
  harness adaptation.

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

    # Agentic proposer: a pi coding-agent session that edits, checks and test-runs the harness
    node src/cli.ts adapt --task rg:word_ladder --proposer-mode agentic --feedback-runs 3

    node src/cli.ts families      # Reasoning Gym families
    node src/cli.ts --help        # all options

Task specs: `toy:addition` (offline smoke task), `rg:<family>` (any Reasoning Gym family; development and
held-out questions come from disjoint generator seeds), and `qa:hotpotqa|musique|2wiki` (after preparing data,
see below).

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

## Results

All runs: solver `qwen.qwen3-32b-v1:0` on Amazon Bedrock, held-out questions never shown to the proposer or used
for selection, one run per configuration. Tables and per-round curves are in `results/`.

**Reasoning Gym, 8 families, 5 rounds** (paper protocol: one proposal per round, kept only if the 25-question
development score improves; 75 held-out questions per family):

| Proposer | Mean held-out, seed -> final | Proposer cost |
|---|---|---|
| Claude Opus 5.5 | 0.201 -> 0.907 | $1.64 |
| Claude Haiku 4.5 | 0.199 -> 0.891 | $0.50 |

Seven of eight families reach 0.96-1.00 in the first round. The structural audit (`results/audit-rg-*.md`) shows
why: these proposers rewrite the harness into an exact algorithm (JavaScript for Opus, Python for Haiku) with the
solver as a fallback, the paper's "algorithm" class. word_ladder, which needs vocabulary the harness cannot
compute, improves slowly through solver-plus-search compositions (0.07 -> 0.26 with Opus).

**Multi-hop QA, 6 rounds** (paper QA protocol: 4 proposals per round, 6 feedback and 32 disjoint scoring
questions, advance to the best candidate; proposer Opus 5.5; 150 held-out questions per benchmark):

| Benchmark | Seed | Peak | Final | HotpotQA-adapted harness |
|---|---|---|---|---|
| HotpotQA | 0.453 | 0.560 | 0.547 | 0.547 |
| MuSiQue | 0.273 | 0.420 | 0.260 | 0.367 |
| 2WikiMultihopQA | 0.500 | 0.680 | 0.653 | 0.647 |

Gains accumulate over rounds, as in the paper, and the harness adapted on HotpotQA transfers to the two
benchmarks it never saw. MuSiQue's final round fell from its 0.420 peak: best-of-G advances even to a worse
candidate, chosen on only 32 noisy scoring questions.

**Agentic versus single-shot proposer** (Haiku 4.5, 8 new families, 3 rounds): 0.249 -> 0.784 agentic versus
0.246 -> 0.764 single-shot. The agentic pi session fixes some families earlier because it can test revisions on
feedback questions, at about 3.6 times the proposer cost (`results/agentic-vs-single.md`).

**Outer loop without weight updates** (`results/transfer.md`): a playbook distilled from 47 revision episodes on
training families raised a weak proposer's (Qwen3-32B) mean held-out gain on 8 unseen families from +0.023 to
+0.101. `tta export` turns runs into GRPO groups (Eq. 8/11 rewards, group advantages) and an SFT corpus with the
App. B.2 filter, for offline proposer training.

Solver calibration: `results/calibration.md`.

## Use from pi

The repository is a pi package. Load it for one session, or install it:

    pi -e ./src/pi/extension.ts
    pi install git:github.com/Singh-AP/test-time-adapting-harness

It adds:

- `adapt_harness` tool: pi's agent can adapt a harness for a task and report held-out scores.
- `/adapt <task> [--rounds N] [--proposals G] [--protocol rg|qa] [--solver ID] [--proposer ID] [--dev N] [--heldout N]`
- `/harness-runs`: recent runs with seed and final held-out scores.

Non-interactive example:

    pi -p --no-session --provider amazon-bedrock --model us.anthropic.claude-sonnet-5 --tools adapt_harness \
      -e ./src/pi/extension.ts "Use adapt_harness on rg:count_primes with 1 round, then report the held-out scores."

## Multi-hop QA data

    for d in hotpotqa musique 2wiki; do mkdir -p data/raw/$d; done
    curl -L -o data/raw/hotpotqa/validation.parquet https://huggingface.co/api/datasets/hotpotqa/hotpot_qa/parquet/distractor/validation/0.parquet
    curl -L -o data/raw/musique/validation.parquet https://huggingface.co/api/datasets/dgslibisey/MuSiQue/parquet/default/validation/0.parquet
    curl -L -o data/raw/2wiki/validation.parquet https://huggingface.co/api/datasets/framolfese/2WikiMultihopQA/parquet/default/validation/0.parquet
    uv pip install --python .venv/bin/python pyarrow==21.0.0
    for d in hotpotqa musique 2wiki; do .venv/bin/python -I python/prepare_qa.py $d data/raw/$d/validation.parquet data/qa/$d; done

Each corpus pools the support and distractor paragraphs of the dev split (HotpotQA 66,635, MuSiQue 21,100,
2Wiki 56,687 paragraphs). Questions are split into disjoint development and held-out sets stratified by type.

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
for untrusted settings. On macOS the guard also sets RLIMIT_NPROC to 0; on Linux it relies on the audit hook and on
disabling `_posixsubprocess.fork_exec`, so prefer a container there.

The agentic proposer's file tools are restricted to its scratch workspace (pi's `@` and `~` path forms included).

## Test

    npm test
    npm run check
