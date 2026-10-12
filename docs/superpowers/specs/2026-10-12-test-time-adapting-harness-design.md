# Test-Time Adapting Harness — Design

Date: 2026-10-12
Source paper: *Harness Learning Enables Generalizable Test-Time Adaptation* (Zhang et al., arXiv:2609.35738v1).
Host framework: [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-*` 1.1.0).

## 1. Intent

**What the user asked for.** Implement a test-time adapting harness, based on the paper, in
`Singh-AP/test-time-adapting-harness`. If feasible, extend the pi agent harness so pi becomes adaptable in
the paper's sense. Research first, then build incrementally with regular commits and pushes. Test against
real end-to-end scenarios. Use Amazon Bedrock in test account `<account-id>` (admin role, credentials from the
AWS credential chain), never leaking credentials. Make informed decisions without waiting for approval.

**What the paper contributes that we implement.**

- A *harness* is an executable program that organizes calls to a frozen *solver* model, tool use, and
  information flow (§3.1).
- A *proposer* reads the task description, the current harness `h_{t-1}`, and an *execution report*, and
  writes a code edit `y_t` (SEARCH/REPLACE spans, §4.2, App. E.1).
- *Test-time adaptation* (the inner loop, Eq. 4): for `t = 1..T`, sample `G` edits, `Apply` them, `Select`
  a retained harness on scoring questions, and build the next report from fresh feedback questions. Both
  models stay frozen; only the harness changes.
- Two selection protocols: Reasoning Gym (`G=1`, keep only if the dev score improves, Eq. 7) and multi-hop
  QA (`G=8`, advance to the best candidate on 64 scoring questions even below the parent, App. D.3).
- Disjoint question sets: `Q_fb` (feedback), `Q_score` (selection), `Q_eval` (held-out, never shown).
- Rewards `r_i = J(h'_i; Q_score) + v_i` with validity terms (Eq. 6, 8, 11) and GRPO group advantages, used
  to train the proposer (the outer loop).

**What we cannot reproduce directly, and the substitute.** The paper trains a 4B proposer with GRPO.
Bedrock does not offer GRPO fine-tuning of the proposer models we use, so the outer loop is implemented as
(a) faithful export of rollouts, rewards, group advantages and an SFT corpus with the paper's filters, so a
proposer can be trained offline, and (b) a non-parametric "revision memory" that distills lessons from
training tasks and is tested for transfer to unseen tasks. The test-time inner loop — the subject of the
repository name — is implemented in full.

**Success criteria.**

1. The adaptation loop runs end to end on Bedrock on real Reasoning Gym families and on multi-hop QA,
   and held-out scores of adapted harnesses are reported against the seed for every round.
2. Held-out questions never reach the proposer or the selection rule (enforced and tested).
3. pi is extended: harnesses run in pi's codemode sandbox, models come from pi-ai, the proposer can be a
   pi coding-agent session, and a pi package exposes adaptation as a `/adapt` command and a tool.
4. No credentials in code, logs, artifacts, or harness/solver-visible environments.
5. Work lands in small commits pushed to `origin/main`, with unit tests passing at each step.

## 2. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | TypeScript on Node ≥ 22.19 (type stripping, no build step), ESM, depending on published `@earendil-works/pi-ai`, `pi-agent-core`, `pi-codemode`, `pi-coding-agent` 1.1.0. | Matches pi; Node 22.23 is installed; no fork to maintain. |
| D2 | A harness is a **JavaScript program run in pi-codemode's QuickJS sandbox**. It must define `async function solve(question)`. Its only capabilities are injected globals (`llm`, `python`, `search`, `log`). | The proposer writes executable code that we run thousands of times. QuickJS has no fs, network, process, or timers, gives per-execution timeouts and memory limits, and runs 25 executions in parallel in ~0.3 s (probed). This is the paper's `harness.py` with a safe runtime. |
| D3 | Budgets and traces are enforced **host-side** in the injected globals (per-question solver-call, retrieval and python budgets; per-question timeout). | A harness cannot bypass limits or hide calls; traces feed the execution report. |
| D4 | Solver-written Python runs in a subprocess with a scrubbed environment (no AWS variables), rlimits (CPU, memory, file size, no forking), a temp working directory, and a `sys.addaudithook` guard that blocks sockets, subprocesses, `os.system`/`exec*`/`fork`, and writes outside the temp directory. | Nested `sandbox-exec` is unavailable inside this session (probed). The audit hook is defense in depth for code our own solver writes on puzzle tasks; the README states the threat model and recommends containers for untrusted settings. |
| D5 | Models are Bedrock via pi-ai's `amazon-bedrock` provider, using profile `<aws-profile>` resolved from `AWS_PROFILE`. Defaults: proposer `us.anthropic.claude-opus-5-5`; solver chosen by a seed-calibration probe from `qwen.qwen3-32b-v1:0`, `us.meta.llama3-1-8b-instruct-v1:0`, `us.amazon.nova-micro-v1:0`. All configurable. | All probed models answer (Fable 5.1 rejected by a data-retention setting, so excluded). Opus 5.5 plays the paper's strong teacher; small solvers leave room for harness gains, as in the paper (4B–8B solvers). |
| D6 | Reasoning Gym is the real `reasoning_gym` 0.1.19 library, driven through a persistent Python 3.12 JSON-lines bridge (generate datasets, score answers). | Faithful tasks and graders; 106 families available (probed). |
| D7 | Multi-hop QA uses HotpotQA (distractor dev), MuSiQue and 2WikiMultihopQA from Hugging Face parquet, converted once to JSONL; corpora are pooled support and distractor paragraphs (as the paper does for MuSiQue/2Wiki), indexed by an in-process BM25. | The paper's 5.23M-abstract full-wiki index is out of scope; pooled corpora preserve the retrieval workflow and transfer evaluation. |
| D8 | Edits use SEARCH/REPLACE blocks parsed from the final answer only; exact unique match, then a whitespace-tolerant fallback; invalid edits get error feedback and retry within an attempt budget (default 3); `NO_CHANGE` declarations score as the parent (App. B.1). A full-file block is accepted as an alternative (the QA protocol's "one code block"). | Mirrors App. E.1 and B.1. |
| D9 | Static screens before execution: defines `solve`, parses in QuickJS, line limit (default 300), no verbatim dev expected answers or long question substrings in code (hard-coding / memorization screens). | Mirrors the paper's static rejection, answer-echo and oracle-access screens. |
| D10 | Proposer variants: (1) **single-shot** prompt proposer (paper-faithful); (2) **agentic** proposer = a pi coding-agent SDK session with `read/edit/write/ls/grep` in a scratch workspace plus custom tools `check_harness` and `run_feedback` (evaluates on `Q_fb` only, budgeted). | (2) is the paper's stated future work (App. F) and is where pi extends naturally. Restricting it to `Q_fb` keeps `Q_score` and `Q_eval` honest. |
| D11 | A pi package (`pi.extensions` in `package.json`) adds `/adapt` (run a configured adaptation in the background with status updates), `/harness-runs` (list runs), and an `adapt_harness` tool. | Makes pi itself the host for test-time harness adaptation. |
| D12 | All run artifacts are written to `runs/<run-id>/` (config, every harness version, proposer responses, reports, per-question traces, scores, cost). Runs are resumable per completed round. `runs/` and `data/` are git-ignored; curated result summaries are committed under `results/`. | Reproducibility without committing bulky or prompt-bearing artifacts. |

## 3. Architecture

```
src/
  core/types.ts         Task, Question, Outcome, Trace, EvalResult, Report, Candidate types
  core/sandbox.ts       runHarness(): codemode sandbox per question, injected globals, timeout
  core/capabilities.ts  llm/python/search/log globals with budgets and trace recording
  core/executor.ts      evaluate(h, Q): concurrency, grading, J(h;Q), outcome counts, traces
  core/screens.ts       static validation (parse, solve defined, lines, hard-coding screens)
  core/edits.ts         SEARCH/REPLACE + full-file parsing, apply, change manifest, NO_CHANGE
  core/report.ts        execution report (App. E.2): score, outcomes, failures with trace excerpts,
                        diff since previous retained harness, revision history
  core/proposer.ts      prompt building (App. E.1), sampling G proposals, retry with feedback
  core/select.ts        greedy-improve (Eq. 7), best-of-G advance (App. D.3), independent
  core/loop.ts          adapt(): Eq. 4 inner loop, per-round held-out eval, artifacts, resume
  core/reward.ts        Eq. 6/8/11 rewards, GRPO advantages, rollout + SFT export
  llm/models.ts         pi-ai Models with Bedrock; retries with backoff on throttling; usage/cost
  tools/python.ts       guarded Python subprocess (D4)
  tools/bm25.ts         BM25 index
  tasks/reasoning-gym/  Python bridge, family registry, dev/held-out split by disjoint seeds
  tasks/qa/             loaders, pooled corpora, normalized EM with aliases, supporting-doc tracking
  tasks/toy/            small TS-native tasks for offline tests
  seeds/                rg-seed.js, tool-loop-baseline.js, qa-seed.js (Fig. 12a)
  proposers/agentic.ts  pi coding-agent SDK proposer (D10)
  pi/extension.ts       pi package entry (D11)
  cli.ts                `tta adapt|eval|independent|report`
python/                 rg_bridge.py, guard.py, prepare_qa.py
test/                   vitest unit tests (stub LLM; no network)
results/                committed summaries of end-to-end experiments
```

**Data flow for one round.** `loop` asks `report` for `x_t` (task description, `h_{t-1}`, score, report
built from executing `h_{t-1}` on `Q_fb_t`). `proposer` samples `G` responses; `edits` applies each to
`h_{t-1}`; `screens` validates; `executor` scores valid candidates on `Q_score_t`; `select` picks `h_t`;
`executor` scores `h_t` on `Q_eval` for reporting only. Every step writes artifacts.

**Harness API (what the proposer programs against).**

```js
// The harness must define: async function solve(question) -> string
// Globals (each call is budgeted and traced; no other I/O exists):
llm(promptOrRequest)          // -> Promise<string>; request: {system, prompt, messages, temperature, maxTokens}
python(code, {timeoutMs})     // -> Promise<{stdout, stderr, exitCode, timedOut}>   (if enabled for the task)
search(query, k)              // -> Promise<[{id, title, text}]>                     (retrieval tasks only)
log(...values)                // records a note in the trace shown in execution reports
TASK                          // read-only {name, description}
```

**Error handling.** Harness exceptions, timeouts and budget exhaustion score 0 for that question and are
recorded with the error kind. Candidates that fail to parse or apply are invalid (`⊥`); under the QA
protocol they score 0, under the Reasoning Gym protocol the parent is kept. Bedrock throttling and 5xx
errors retry with exponential backoff and jitter; persistent model errors fail the question, not the run.
The Python bridge restarts on crash.

## 4. Testing

- Unit tests (vitest, offline) for edits, screens, sandbox capability isolation (no `process`, `fetch`,
  `require`), budget enforcement, executor scoring with a stub LLM, report content (held-out never
  present), selection rules, rewards and advantages, BM25, python guard, QA normalization.
- End-to-end runs on Bedrock (not in the unit suite), with results committed under `results/`:
  1. Reasoning Gym sequential adaptation on unseen-style families (for example `maze`, `count_primes`,
     `caesar_cipher`, `sudoku`, `group_anagrams`, `palindrome_partitioning`, `rotten_oranges`,
     `word_ladder`): held-out score per round versus seed and the fixed tool-loop baseline.
  2. Independent single-step proposals (mean and best-of-G) versus sequential revision.
  3. Multi-hop QA best-of-G adaptation on HotpotQA with transfer of the procedure to MuSiQue and 2Wiki.
  4. Agentic pi proposer versus single-shot proposer.
  5. The pi package driven through the pi CLI in non-interactive mode.
  6. Proposer strength comparison (for example Opus 5.5 versus Haiku 4.5) as the Base/Teacher analog.

## 5. Delivery increments

Each increment ends with passing tests, a commit, and a push.

1. Spec, plan, scaffold, README.
2. Sandbox, capabilities, executor, toy tasks (offline tests).
3. Edits, screens, proposer prompt and parsing.
4. Report, selection, loop, rewards, artifacts.
5. Bedrock model layer; first live smoke run on a toy task.
6. Reasoning Gym bridge, python guard, seeds; calibration of the solver; first real adaptation runs.
7. CLI and results reporting; Reasoning Gym experiments.
8. Multi-hop QA suite and experiments.
9. Agentic pi proposer and comparison.
10. pi package (`/adapt`, tool) and CLI end-to-end check.
11. Outer-loop extras: rollout/SFT export, revision-memory transfer.

## 6. Out of scope

GRPO training of a proposer, the 5.23M-abstract HotpotQA full-wiki index, format-varied Reasoning Gym
questions, and joint solver/proposer training.
