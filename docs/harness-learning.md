# Harness Learning on reasoning and QA tasks

This part of the repository implements *Harness Learning Enables Generalizable Test-Time Adaptation* (Zhang et al.,
arXiv:2609.35738) on the [pi](https://github.com/earendil-works/pi) agent toolkit.

A *harness* is the program that organizes the calls to a frozen solver model, tool use and information flow. A
*proposer* model reads the task description, the current harness and an execution report, then edits the harness.
Repeating this on development questions adapts the harness to a new task without changing any model weights
(paper Eq. 4):

```
for t = 1..T:
    report_t   = run h_{t-1} on feedback questions Q_fb, summarize traces and failures
    y_i        ~ proposer(task, h_{t-1}, report_t)          i = 1..G   (SEARCH/REPLACE edits)
    h'_i       = Apply(h_{t-1}, y_i)                        (invalid if edits do not apply or fail screens)
    h_t        = Select(h_{t-1}, {h'_i}; Q_score)           (greedy-improve or best-of-G)
    report J(h_t; Q_eval) on held-out questions             (never shown to the proposer)
```

## How it uses pi

- **The sandbox.** Harnesses are JavaScript programs run in **pi-codemode**'s QuickJS sandbox, in a fresh VM for each
  question. Their only capabilities are functions the host injects, each with a per-question budget and full
  tracing:
  - `llm()`, the frozen solver;
  - `python()`, a guarded subprocess;
  - `search()`, for retrieval tasks;
  - `log()`.
- **Models.** Solver and proposer models are **pi-ai** models from any provider: `provider/model-id`, or a bare
  Amazon Bedrock id.
- **The agentic proposer** is a **pi coding-agent** session. It edits `harness.js` in a scratch workspace and has two
  extra tools: `check_harness` and `run_feedback`, which runs feedback questions only. This is the paper's App. F
  future work.
- **The pi package** adds an `adapt_harness` tool and the `/adapt` and `/harness-runs` commands, so pi itself runs
  test-time harness adaptation.

## Components

- **The engine** (`src/core`) covers:
  - sandboxed harness execution, execution reports and SEARCH/REPLACE edits;
  - static screens, and greedy and best-of-G selection;
  - the Eq. 4 loop, with artifacts and resume;
  - single-step evaluation, Eq. 8 and 11 rewards, and GRPO group advantages.
- **The proposers** are a single-shot prompt proposer, faithful to the paper, and the agentic pi proposer.
- **The tasks** are:
  - Reasoning Gym families, using the real `reasoning_gym` generators and verifiers;
  - multi-hop QA (HotpotQA, MuSiQue, 2WikiMultihopQA) over pooled paragraph corpora, with BM25 retrieval.
- **The outer loop.** `tta export` turns runs into GRPO groups (Eq. 8 and 11 rewards, group advantages) and an SFT
  corpus filtered as in App. B.2, for offline proposer training. `tta playbook` distills revision lessons that
  transfer to unseen tasks.

## Setup and usage

```bash
scripts/install.sh learning         # Node packages and .venv with reasoning-gym and pyarrow
export ANTHROPIC_API_KEY=...        # or another provider's key, or AWS credentials for Bedrock

# Score a harness
node src/cli.ts eval --task rg:maze --harness seeds/rg-seed.js --solver <model>

# Test-time adaptation, Reasoning Gym protocol (5 rounds, one proposal per round, keep only improvements)
node src/cli.ts adapt --task rg:maze --rounds 5 --solver <model> --proposer anthropic/claude-opus-5-5

# Multi-hop QA protocol (best-of-G, disjoint feedback and scoring questions)
node src/cli.ts adapt --task qa:hotpotqa --protocol qa --rounds 10 --proposals 8

# Single step: eight independent proposals from the seed, scored on held-out questions
node src/cli.ts independent --task rg:maze --proposals 8

# The agentic proposer
node src/cli.ts adapt --task rg:word_ladder --proposer-mode agentic --feedback-runs 3

node src/cli.ts families      # Reasoning Gym families
node src/cli.ts --help        # all options
```

The defaults are the solver `qwen.qwen3-32b-v1:0` and the proposer `us.anthropic.claude-opus-5-5`, both on Amazon
Bedrock. Override them with `--solver`, `--proposer`, `TTA_SOLVER_MODEL` or `TTA_PROPOSER_MODEL`. The task specs are:

- `toy:addition`, an offline smoke task;
- `rg:<family>`, any Reasoning Gym family, with development and held-out questions from disjoint generator seeds;
- `qa:hotpotqa`, `qa:musique` and `qa:2wiki`, after preparing the data (below).

Every run writes `runs/<id>/`:

| Path | Content |
|---|---|
| `config.json`, `seed.js` | Task, protocol configuration, seed harness |
| `round-00/heldout.*` | Seed held-out evaluation |
| `round-NN/feedback.*`, `report.md` | Parent evaluation on Q_fb and the execution report given to the proposer |
| `round-NN/candidates/cK/` | `transcript.md` (prompts and responses), `proposal.json`, `harness.js`, `score.*` |
| `round-NN/selected.js`, `heldout.*`, `round.json` | The retained harness, its held-out score, a round summary |
| `state.json` | Resume point: rerun the same command with `--run-dir` to continue |
| `final.js`, `summary.{json,md}` | The adapted harness, and per-round results with token usage and cost |

`*.json` evaluations hold per-question outcomes, and `*.traces.jsonl` files hold every solver, python and search call.

## Writing a harness

```js
// Available globals: TASK, llm(), python(), search(), log(). No other I/O exists.
async function solve(question) {
	const reply = await llm({ system: "Solve the problem. End with: Answer: <answer>", prompt: question });
	return reply.split(/answer\s*:/i).pop().trim();
}
```

- **`llm(request)`** takes a prompt string or `{system, prompt, messages, temperature, maxTokens}`, and returns the
  solver's text.
- **`python(code, {timeoutMs, stdin})`** returns `{stdout, stderr, exitCode, timedOut}`.
- **`TASK`** is a frozen `{name, description}`.
- **Return value.** `solve` returns a string; other values are JSON-stringified.
- **Budgets.** Each question gets 12 `llm`, 12 `python` and 12 `search` calls, a 300-second limit, and at most 4,096
  tokens per solver call.
- **Outcomes.** A call beyond a budget throws. Outcomes are `correct`, `partial`, `wrong`, `error`, `timeout` or
  `budget`.

## Protocols and leakage discipline

- **`rg`** (paper App. B.1):
  - one proposal per round (G=1);
  - the whole development set is used for both feedback and scoring;
  - a candidate is kept only if it is strictly better, with up to 3 attempts;
  - nothing is sampled once the parent scores 1.0.
- **`qa`** (paper App. D.3):
  - best-of-G;
  - 6 feedback and 64 disjoint scoring questions per round;
  - the run advances to the best runnable candidate even if it is worse, with one attempt.
- **Leakage discipline**, covered by tests:
  - Reports and proposer prompts are built only from feedback questions.
  - Selection uses only scoring questions.
  - Held-out questions are used only for reporting.
  - Every question and answer shown to the proposer is added to the hard-coding screens.

## Results

All runs use the solver `qwen.qwen3-32b-v1:0` on Amazon Bedrock and one run per configuration. Held-out questions
were never shown to the proposer or used for selection. Tables and per-round curves are in `results/`.

**Reasoning Gym, 8 families, 5 rounds.** These runs follow the paper protocol: one proposal per round, kept only if
the 25-question development score improves, and 75 held-out questions per family.

| Proposer | Mean held-out, seed -> final | Proposer cost |
|---|---|---|
| Claude Opus 5.5 | 0.201 -> 0.907 | $1.64 |
| Claude Haiku 4.5 | 0.199 -> 0.891 | $0.50 |

- Seven of eight families reach 0.96 to 1.00 in the first round. The structural audit (`results/audit-rg-*.md`)
  shows why: these proposers rewrite the harness into an exact algorithm, with the solver as a fallback. That is
  the paper's "algorithm" class. Opus writes the algorithm in JavaScript, Haiku in Python.
- word_ladder needs vocabulary the harness cannot compute. It improves slowly, through solver-plus-search
  compositions: 0.07 -> 0.26 with Opus.

**Multi-hop QA, 6 rounds.** These runs follow the paper's QA protocol: 4 proposals per round, 6 feedback and 32
disjoint scoring questions, and the run advances to the best candidate. The proposer is Opus 5.5, with 150
held-out questions per benchmark.

| Benchmark | Seed | Peak | Final | HotpotQA-adapted harness |
|---|---|---|---|---|
| HotpotQA | 0.453 | 0.560 | 0.547 | 0.547 |
| MuSiQue | 0.273 | 0.420 | 0.260 | 0.367 |
| 2WikiMultihopQA | 0.500 | 0.680 | 0.653 | 0.647 |

- Gains accumulate over rounds, as in the paper.
- The harness adapted on HotpotQA transfers to the two benchmarks it never saw.
- MuSiQue's final round fell from its 0.420 peak. Best-of-G advances even to a worse candidate, chosen on only 32
  noisy scoring questions.

**Agentic versus single-shot proposer** (Haiku 4.5, 8 new families, 3 rounds). Mean held-out is 0.753 for the
agentic proposer against 0.614 for single-shot after round 1, and 0.784 against 0.764 after round 3. The agentic
pi session adapts faster because it can test revisions on feedback questions. It costs about 4 times as much
(`results/agentic-vs-single.md`).

**Outer loop without weight updates** (`results/transfer.md`). A playbook distilled from 47 revision episodes on
training families raised a weak proposer's (Qwen3-32B) mean held-out gain on 8 unseen families from +0.023 to
+0.101.

Solver calibration is in `results/calibration.md`.

## Multi-hop QA data

```bash
for d in hotpotqa musique 2wiki; do mkdir -p data/raw/$d; done
curl -L -o data/raw/hotpotqa/validation.parquet https://huggingface.co/api/datasets/hotpotqa/hotpot_qa/parquet/distractor/validation/0.parquet
curl -L -o data/raw/musique/validation.parquet https://huggingface.co/api/datasets/dgslibisey/MuSiQue/parquet/default/validation/0.parquet
curl -L -o data/raw/2wiki/validation.parquet https://huggingface.co/api/datasets/framolfese/2WikiMultihopQA/parquet/default/validation/0.parquet
for d in hotpotqa musique 2wiki; do .venv/bin/python -I python/prepare_qa.py $d data/raw/$d/validation.parquet data/qa/$d; done
```

- **Corpora.** Each corpus pools the support and distractor paragraphs of the dev split: 66,635 paragraphs for
  HotpotQA, 21,100 for MuSiQue and 56,687 for 2Wiki.
- **Questions** are split into disjoint development and held-out sets, stratified by type.

## Use from pi

```bash
node_modules/.bin/pi -e ./src/pi/extension.ts
```

The package adds these:

- **The `adapt_harness` tool**: pi's agent can adapt a harness for a task and report held-out scores.
- **`/adapt`**:
  `/adapt <task> [--rounds N] [--proposals G] [--protocol rg|qa] [--solver ID] [--proposer ID] [--dev N] [--heldout N]`
- **`/harness-runs`**: recent runs with their seed and final held-out scores.

## Design decisions

- **Runtime.** TypeScript on Node 22.19 or newer with type stripping, so there is no build step. It depends on the
  published pi packages, not a fork.
- **Harness code.** A harness is JavaScript in QuickJS, so proposer-written code runs thousands of times without
  filesystem, network, process or timer access. Budgets and traces are enforced on the host, in the injected
  functions, so a harness can neither exceed them nor hide calls.
- **Edits** are SEARCH/REPLACE blocks parsed from the proposer's final answer. Matching is exact first, then
  whitespace-tolerant. Invalid edits get error feedback and retry within an attempt budget. A `NO_CHANGE`
  declaration scores as the parent, and a full-file code block is also accepted.
- **Static screens** run before execution. A harness must define `solve`, parse in QuickJS and stay within a line
  limit. It may not contain development answers or long question substrings.
- **Reasoning Gym** is the real `reasoning_gym` library, driven through a persistent Python JSON-lines bridge, so the
  tasks and graders are faithful.
- **QA corpora** pool the dev split's paragraphs and are indexed by an in-process BM25. The paper's 5.23M-abstract
  full-Wikipedia index is out of scope.
- **The outer loop.** The paper trains a proposer with GRPO. Instead, this repository exports rollouts, rewards,
  group advantages and an SFT corpus for offline training, and tests a non-parametric playbook for transfer.

## Safety

- **Harness code** written by a proposer runs only inside QuickJS: no filesystem, network, process or timers.
- **Solver-written Python** runs through `python/guard.py`:
  - a scrubbed environment, with no AWS variables;
  - a temporary working directory and resource limits;
  - an audit hook that blocks sockets, subprocesses, native library loading, and file access outside the scratch
    directory and the Python installation.
- **This is defense in depth, not a security boundary.** Use a container for untrusted settings.
  - On macOS the guard also sets RLIMIT_NPROC to 0.
  - On Linux it relies on the audit hook and on disabling `_posixsubprocess.fork_exec`, so prefer a container there.
- **The agentic proposer's** file tools are restricted to its scratch workspace, including pi's `@` and `~` path
  forms.
