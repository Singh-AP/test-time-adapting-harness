# Handover

State as of 2026-10-13. `main` is pushed to `origin/main` (github.com/Singh-AP/test-time-adapting-harness).
`npm test` passes 124/124 and `npm run check` (Biome and TypeScript) is clean. Nothing is running.

## 1. The goal and where it stands

The user asked for: a test-time adapting harness based on the paper *Harness Learning Enables Generalizable
Test-Time Adaptation* (arXiv:2609.35738; the PDF is at `/Users/<user>/Downloads/2609.35738v1.pdf`), extending the
pi agent toolkit (github.com/earendil-works/pi) so that pi is adaptable in the paper's sense. The working
instructions were:

- research the paper and pi deeply before building;
- deliver incrementally, with regular commits pushed to origin;
- test end to end against real scenarios;
- make decisions without stopping to ask;
- use Amazon Bedrock in the test account `<account-id>` (admin role), with credentials from the AWS credential chain;
- never leak credentials.

Status: the work is done and delivered.

- Four plans were executed: the core engine with Reasoning Gym, multi-hop QA, the agentic proposer with the
  pi package, and the outer loop.
- A fresh-reviewer final review was run and its Critical and Important findings were fixed, each with a test.
- End-to-end results are committed in `results/` and summarized in the README.
- Total Bedrock spend was about $28.

Last open question from the user: "why is it only Bedrock?" I offered provider-agnostic model support (about
an hour of work, see §9). The user has not answered yet.

## 2. Repository map

| Path | What it is |
|---|---|
| `src/core/types.ts`, `usage.ts` | Task, Question, outcomes, traces, and the client interfaces (Solver, Proposer, Python, Search) |
| `src/core/capabilities.ts` | The globals a harness can call (`llm`, `python`, `search`, `log`), with per-question budgets and tracing |
| `src/core/sandbox.ts` | `runHarness()`: one pi-codemode QuickJS VM per question; `buildProgram()` wraps the source and calls `solve(prompt)` |
| `src/core/executor.ts` | `evaluateHarness()` computes J(h;Q); `classifyOutcome()` |
| `src/core/edits.ts` | Parses SEARCH/REPLACE blocks, full-file code blocks and `NO_CHANGE`; `applyEdits()` with exact matching first, then whitespace-tolerant matching; `extractSection()` |
| `src/core/screens.ts` | Static rejection before execution: size, line count, hard-coded answers, question-specific text, loads in QuickJS |
| `src/core/report.ts` | Execution report (paper App. E.2): scores, failure traces, diff from the previous harness, revision history |
| `src/core/prompts.ts`, `proposer.ts` | Single-shot proposer: system prompt and revision prompt, retries with error feedback; `ProposeFn`, `FeedbackContext`, `failedProposal()` |
| `src/core/select.ts`, `reward.ts` | Greedy selection (Eq. 7), best-of-G selection (App. D.3); rewards (Eq. 8 and 11); GRPO group advantages |
| `src/core/loop.ts` | `adapt()`: the Eq. 4 loop, artifacts, resume, `skipPerfect`, playbook passthrough. Presets `REASONING_GYM_PROTOCOL` and `QA_PROTOCOL` |
| `src/core/independent.ts` | Single-step mode: N independent proposals from the seed, each scored on held-out questions |
| `src/core/store.ts` | `RunStore`, which writes run artifacts |
| `src/llm/pi-clients.ts` | Bedrock through pi-ai: `PiSolverClient`, `PiProposerClient`, retries, expired-credential wait and reload, `usageOf` |
| `src/tools/python.ts`, `python/guard.py` | Guarded Python subprocess for solver-written code |
| `src/tools/bm25.ts` | In-memory BM25 index |
| `src/tasks/toy.ts`, `reasoning-gym/`, `qa/`, `registry.ts` | Task specs: `toy:addition`, `rg:<family>`, `qa:hotpotqa`, `qa:musique`, `qa:2wiki` |
| `python/rg_bridge.py`, `python/prepare_qa.py` | Reasoning Gym JSON-lines bridge; QA parquet-to-JSONL converter |
| `src/proposers/agentic.ts` | Agentic proposer: a pi coding-agent SDK session with guarded read/edit/write, `check_harness` and `run_feedback` |
| `src/pi/extension.ts`, `service.ts` | pi package: `adapt_harness` tool and the `/adapt` and `/harness-runs` commands |
| `src/learning/export.ts`, `playbook.ts`, `audit.ts` | GRPO and SFT export; playbook distillation; structural classifier |
| `src/cli.ts` | `tta adapt / independent / eval / families / export / playbook` |
| `src/config.ts` | `repoPath`, `defaultPythonPath` (TTA_PYTHON, then .venv, then python3), `defaultSeedFile`, default model IDs |
| `seeds/` | `rg-seed.js` (one solver call), `tool-loop.js` (Python for up to 5 turns), `qa-seed.js` (paper Fig. 12a) |
| `experiments/` | `calibrate.ts`, `rg-suite.ts`, `qa-suite.ts`, `audit.ts` |
| `results/` | Committed result tables (see §8) |
| `docs/superpowers/specs/`, `plans/` | The design spec and four plans. The plans contain code as tagged blocks; where they differ, the code is authoritative |
| `data/`, `runs/` (git-ignored) | Raw and prepared QA data; every run's artifacts |

## 3. How to run

Every command that calls Bedrock needs the prefix `AWS_PROFILE=<aws-profile>`, after vending credentials
(§4). `npm test` and `npm run check` do not call Bedrock. `AWS_REGION` defaults to `us-east-1`. `pi` is not on
`PATH`; run it as `node_modules/.bin/pi`.

```bash
npm install --ignore-scripts
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python reasoning-gym==0.1.19 pyarrow==21.0.0
npm test && npm run check
node src/cli.ts adapt --task rg:maze --rounds 3   # artifacts in runs/<id>/ (summary.md, final.js, round-NN/...)
node src/cli.ts adapt --task rg:count_primes --rounds 1 --dev 8 --heldout 10 --proposer-mode agentic
node experiments/rg-suite.ts --families maze,sudoku --rounds 5 --tag mytag --out results/x.md [--proposer ID] [--proposer-mode agentic] [--playbook results/playbook.md]
node experiments/qa-suite.ts --datasets hotpotqa,musique,2wiki --rounds 6 --proposals 4 --scoring 32 --heldout 150 --tag t --out results/qa.md
node experiments/audit.ts --out results/audit.md runs/<run-dir>...
node src/cli.ts export --out data/learning runs/<run-dir>...      # rollouts.jsonl and sft.jsonl
node src/cli.ts playbook --out results/playbook.md runs/<run-dir>...
node_modules/.bin/pi -p --no-session --provider amazon-bedrock --model us.anthropic.claude-sonnet-5 --tools adapt_harness -e ./src/pi/extension.ts "Use adapt_harness on rg:count_primes with 1 round"
```

The QA data is already prepared under `data/qa/`. The download and preparation commands are in the README.

## 4. Credentials and environment (read this before any AWS call)

- **Getting credentials.** Use AWS credentials from a profile or the environment, scoped to Bedrock invocation. Never print credential values.
- **Lifetime is about one hour.** The role caps the session at about an hour, even though 720 minutes are
  requested. Check the returned `expiration` (Unix seconds) and vend again before it.
- **Long runs survive expiry.** On an `ExpiredToken` error, `completeWithRetry` polls every 20 seconds for up to
  45 minutes, reloading the AWS SDK's cached credentials file with `loadSharedConfigFiles({ignoreCache: true})`
  from `@smithy/core/config`. Re-vending during a run lets it resume. This was verified live.
- **Sandbox quirks.**
  - `ps` is not permitted; track background work through task notifications.
  - Nested `sandbox-exec` fails.
  - The system `python3` is 3.9; use `.venv`, which has Python 3.12 with reasoning-gym, numpy and sympy.
- **Bedrock models.**
  - Work: `qwen.qwen3-32b-v1:0` (default solver), `us.anthropic.claude-opus-5-5` (default proposer),
    `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `us.anthropic.claude-sonnet-5`,
    `us.meta.llama3-1-8b-instruct-v1:0`, `us.amazon.nova-micro-v1:0`.
  - Fails: `us.anthropic.claude-fable-5-1`, with "data retention mode 'default' is not available".
  - No throttling was seen with five suites running concurrently.

## 5. Design facts a new agent must know

**The harness contract**

- A harness is plain JavaScript that defines `async function solve(question)` and returns a string. Non-string
  return values are JSON-stringified.
- It runs in a fresh QuickJS VM for each question. There is no filesystem, network, process access or timers.
- `TASK` is a frozen object `{name, description}`.
- Defaults: 12 `llm`, 12 `python` and 12 `search` calls per question; a 300-second limit per question;
  4,096 tokens at most per solver call.
- Calls beyond a budget throw. The outcome kinds are `correct`, `partial`, `wrong`, `error`, `timeout` and
  `budget`.

**Protocols**

- `rg` (paper App. B.1): G=1, the whole dev set is used for both feedback and scoring, a candidate is kept only
  if it is strictly better, up to 3 attempts. `skipPerfect` samples nothing once the parent scores 1.0 on the
  scoring set.
- `qa` (paper App. D.3): best-of-G, 6 feedback questions and 64 disjoint scoring questions per round, the run
  advances to the best runnable candidate even if it is worse, 1 attempt. The experiments used G=4 and 32
  scoring questions to save cost.

**Leakage discipline (tested)**

- Reports and proposer prompts are built only from feedback questions.
- Selection uses only scoring questions.
- Held-out questions are used only for reporting.
- Every question and answer shown to the proposer is added to the hard-coding screens.

**Run artifacts**

Each run directory holds:

- `config.json`, `seed.js`
- `round-00/heldout.*`
- `round-NN/feedback.*`, `report.md`, `candidates/cK/{transcript.md, transcript.json, proposal.json, harness.js, score.*}`, `selected.js`, `heldout.*`, `round.json`
- `state.json` (to resume, rerun with the same `--run-dir`)
- `final.js`, `summary.{json,md}`

**Agentic proposer**

- The workspace contains `harness.js`, `REPORT.md`, `TASK.md` and optionally `PLAYBOOK.md`.
- The built-in pi tools are disabled (`noTools: "builtin"`). The read, edit and write tools are replaced by
  copies wrapped in `guardPath`, which applies pi's own `@` stripping and `~` expansion before checking that the
  path stays inside the workspace.
- `run_feedback` evaluates only the feedback questions, at most 3 times per proposal.
- The workspace is removed in a `finally` block.

**Python guard**

- The environment is scrubbed (no AWS variables); there are rlimits; and a PEP 578 audit hook blocks sockets,
  subprocesses, `os.system`/`exec`/`fork`/`spawn`, `ctypes.*` events, file writes outside the scratch
  directory, and file reads outside the scratch directory and the Python installation.
- `_posixsubprocess.fork_exec` is replaced before user code runs.
- `ctypes` is preloaded because sympy needs it.
- This is defense in depth, not a security boundary.

**Testing approach**

- Unit tests use stub clients and pi-ai's `fauxProvider`.
- The agentic proposer tests register the faux provider on a pi `ModelRuntime` with `registerNativeProvider`,
  so a scripted model drives pi's real tools.
- `fauxProvider` overwrites scripted usage, so `usageOf` is unit-tested directly.

## 6. Process and conventions

- **Superpowers workflow.**
  - Brainstorming produced the spec; writing-plans produced the plans; executing-plans ran them inline with TDD.
  - For each task: write the failing test and watch it fail, implement, watch it pass, then run `npm test`,
    `npm run check`, commit and push.
  - The ledgers lived in `.superpowers/sdd/` and were deleted at the end; the rulings are listed in the final
    chat message and in git history.
- **Code style.**
  - Biome with tabs (indent width 3, line width 120).
  - Node type stripping: erasable syntax only, so no enums and no parameter properties; relative imports end in
    `.ts`.
  - Exact pinned dependencies.
  - Biome reformats on `check`, so re-read a file before scripted search-and-replace edits; several scripted
    edits failed because a line had been wrapped.
- **Commits** go straight to `main` and are pushed after each task. The user asked for this.
- **The user can pause testing.** When the user said "pause the testing", all experiments stopped, even though
  the `/goal` stop hook kept insisting the goal was unmet. Work resumed only when the user said "continue".

## 7. Pitfalls and how they were handled

1. **Credentials expired mid-run.** Calls failed with `ExpiredTokenException`, and re-vending did not help
   running processes because the SDK caches the credentials file. Fixed with the expired-credential wait and
   reload (§4).
2. **Nested `sandbox-exec` is unavailable**, so the Python guard is built from an audit hook, rlimits and a
   scrubbed environment.
3. **numpy calls `os.putenv` at import**, so `os.putenv` is no longer blocked. **sympy imports `ctypes`**, so
   `ctypes` is preloaded while its `dlopen` and raw-memory events stay blocked.
4. **A guard test assumed `~` pointed at the real home directory**, but `HOME` is scrubbed. The test now builds
   the path from `os.homedir()`.
5. **`clipMiddle` reserved too much space for its marker.** Fixed under TDD.
6. **Proposer input tokens were under-counted**, because pi-ai reports cached prompt tokens separately. `usageOf`
   now adds `cacheRead` and `cacheWrite`.
7. **The toy task was already perfect**, so `skipPerfect` meant no proposal ever ran. Smoke tests use
   `rg:count_primes` with 8 dev and 10 held-out questions instead.
8. **Frontier proposers saturate Reasoning Gym in round 1** by rewriting harnesses into exact algorithms with
   zero solver calls (see `results/audit-*.md`). Weaker-proposer runs (Qwen3-32B) and unseen families were
   added to measure multi-round adaptation. The structural classifier first mislabeled proposer-written Python
   algorithms as interpreter loops; it now separates `algorithm-python` from `interpreter`.
9. **QA proposers quoted development answers as prompt examples.** The hard-coding screen correctly rejected all
   4 candidates in a MuSiQue round, wasting it, because the QA protocol allows one attempt. The proposer rules
   now say "not even as examples", and the screen's feedback says the same.
10. **MuSiQue fell from 0.420 to 0.260 in the final round.** Best-of-G advances even to a worse candidate, chosen
    on only 32 noisy scoring questions. This is reported honestly; see §9 for mitigations.
11. **The final reviewer subagent hit API 429 rate limits three times.** It was resumed with `SendMessage`,
    asking it to write the report immediately.
12. **Review findings, all fixed with tests:**
    - Critical: `guardPath` could be bypassed through pi's `@` and `~` path forms.
    - Important: the CLI used the Reasoning Gym seed for QA tasks.
    - Important: a `ProposeFn` that throws ended the whole run.
    - Important: raw `fork_exec` could spawn processes without an audit event.
    - Important: the "no examples" prompt rule above.
    An audit of all 236 agentic tool calls found that none touched anything outside the workspace, and pi's
    `auth.json` files are empty.
13. **An arithmetic slip in a hand-computed results table** (agentic versus single-shot round means) was caught
    by recomputing and corrected in a follow-up commit. Compute aggregates with a script, not by hand.
14. **Plan code had small defects** (for example `require` in ESM, and a test that misused the faux provider).
    These were fixed under TDD and recorded as rulings.

## 8. Experiments run

Every run used solver Qwen3-32B and one run per configuration. The run directories are under `runs/`.

| Tag | What | Results file | Headline |
|---|---|---|---|
| calibration | 3 solvers × 6 families, seed versus tool loop | `results/calibration.md` | Qwen3-32B chosen; it uses code best |
| `rg-v1` | Reasoning Gym, 8 families, 5 rounds, Opus 5.5 | `results/reasoning-gym-multistep.md` | 0.201 -> 0.907; 7/8 became JavaScript algorithms |
| `rg-haiku-single` | Same, Haiku 4.5 | `results/reasoning-gym-haiku-single.md` | 0.199 -> 0.891; Python algorithms |
| `qa-v1` | HotpotQA, MuSiQue, 2Wiki; 6 rounds; G=4; 32 scoring and 150 held-out questions | `results/qa-multistep.md` | 0.453 -> 0.547, 0.273 -> 0.260 (peak 0.420), 0.500 -> 0.653; the HotpotQA harness transfers |
| `f2-haiku-single` / `f2-haiku-agentic` | 8 new families, 3 rounds | `results/agentic-vs-single.md` | Agentic 0.753 versus single-shot 0.614 after round 1; about 4× the proposer cost |
| `transfer-none` / `transfer-playbook` | Qwen3-32B proposer, 8 unseen families, with and without the playbook | `results/transfer.md` | Gain +0.023 without the playbook versus +0.101 with it |
| — | Structural audits | `results/audit-*.md` | Classes per run |
| — | `pi -p` end to end, smoke runs, post-fix checks | (in chat) | `adapt_harness` works from the pi CLI |

## 9. Open items

1. **Provider-agnostic models** (the user's latest question; proposed, not started):
   - register all pi-ai providers with `builtinModels()`;
   - accept `provider/model` IDs on `--solver` and `--proposer`, and in the suites and the pi service;
   - in `createBedrockAgenticProposer`, generalize the provider;
   - in the pi extension, optionally use the session's own models (`ctx.modelRegistry`).
2. **Distribution.** Publish to npm, and test `pi install git:...`. That route needs `TTA_PYTHON`, and runs would
   be written inside the installed package directory, so make the runs root configurable (for example
   `TTA_RUNS_DIR`).
3. **Deferred review minors:**
   - the full `Task` object, held-out questions included, reaches `ProposeFn` implementations;
   - `/adapt` accepts `--rounds 0` and treats an unknown protocol as `rg`;
   - `--temperature` with a non-number becomes NaN;
   - QA supporting-document tracking parses titles from truncated trace text;
   - `clipMiddle` can overshoot its limit slightly;
   - cached held-out evaluations keep the first round's label;
   - GRPO export uses the first candidate's prompt even when branch hints differ per candidate.
4. **Statistical strength.** The paper averages 4 runs; this work has one run per configuration. Repeat the key
   comparisons (agentic versus single-shot, playbook transfer, QA).
5. **QA selection noise.** Options: larger scoring sets, re-scoring the top candidates on more questions, or
   keeping the best harness over all rounds as an oracle-free option.
6. **Paper items not done:**
   - GRPO or SFT training of a proposer (`tta export` produces the data);
   - the 5.23M-abstract full-Wikipedia index;
   - format-varied Reasoning Gym questions;
   - composition directives that force the harness to use the solver.

## 10. Reference checkouts and data

- `../_ref/pi`: a shallow clone of the pi repository, used to read docs and sources (`packages/*/README.md`,
  `packages/coding-agent/docs/*.md`).
- Installed pi packages: `@earendil-works/pi-ai`, `pi-codemode` and `pi-coding-agent` at 1.1.0. For exact APIs,
  read their type declarations under `node_modules`.
- `data/raw/<dataset>/validation.parquet` holds the Hugging Face downloads (treat them as untrusted data).
  `data/qa/<dataset>/{corpus,questions}.jsonl` holds the prepared files. Corpus sizes: HotpotQA 66,635
  paragraphs, MuSiQue 21,100, 2Wiki 56,687.
