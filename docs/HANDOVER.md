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

## 11. Terminal-Bench 4.0 (in progress since 2026-10-14)

**Goal (user, /goal):** this harness reaches state of the art or better on Terminal-Bench 4.0. Set up the benchmark
environment, test it, and verify the harness after each major change. **Order of work (user):** improve the harness
with Sonnet 5.5 as the agent model; switch to Opus 5.5 only once no further harness improvement is possible.

**Target.**

- TB 4.0 has 66 tasks, each with an 8 h agent timeout. Three need an H100: `fp8-rmsnorm-gemm`, `jax-speedrun-gpu`
  and `math-eval-grader`.
- Leaderboard as of 2026-10-06, 5 trials per task:
  - Claude Code + Opus 5.5 (max effort): 64.85% ± 3.1; $4.7k; 80 min per trial.
  - Claude Code + Sonnet 5.5 (max effort): 61.82%.
- Read it with `.venv-harbor/bin/harbor hub leaderboard show terminal-bench/terminal-bench/4-0-0 --json`.

**Architecture.**

- Harbor 0.24.0 runs in `.venv-harbor`, set up with `uv venv --python 3.12 .venv-harbor && uv pip install 'harbor[ec2]==0.24.0'`.
- Harbor runs on EC2 runner hosts with the Docker environment.
- The agent is `python/tbench/harbor_agent.py:PiHarnessAgent`, an external Harbor agent. It spawns
  `src/tbench/main.ts`, a pi SDK session on the host, and relays exec, upload and download requests over a JSON-lines
  bridge (`src/tbench/bridge.ts`) to Harbor's environment API.
- Tools:
  - `bash` is our own (`src/tbench/remote.ts`, `RemoteShell`). It writes the command to a script, runs it under
    `timeout` with stdin from `/dev/null` and output in a log file, and returns only the head and tail.
  - read, edit and write are pi's own tools with remote operations.
- Credentials never enter containers. Bedrock calls are made on the host with the instance role `tta-tbench-runner`,
  which may only invoke Bedrock. IMDSv2 uses hop limit 1, so containers can't reach the role.
- pi only recognizes credentials signalled by env vars or a profile, so hosts have the profile `tta-instance` with
  `credential_process = python3 python/tbench/imds_credentials.py`. The agent defaults `AWS_PROFILE` to it.

**Harness format** (`harnesses/tbench/<version>/`, loaded by `src/tbench/harness.ts`):

- `system.md`, `user.md` (`{{instruction}}`, `{{environment}}`, `{{time_budget}}`), `probe.sh` (an environment
  snapshot injected into the first message);
- `finish.md` (the verification prompt sent when the agent first stops);
- `review*.md`: a fresh-context reviewer that audits the container. Its FAIL issues go back to the agent, for up to
  `review.maxRounds` rounds;
- `harness.json`: thinking level, bash limits, compaction window, time warnings.

Versions:

- v0: prompt, probe and finish check.
- v1: v0 plus the reviewer and an all-or-nothing persistence prompt.

**Harness learning** (`src/tbench/cli.ts`):

- `report` builds a dev-only execution report from synced jobs (`src/tbench/report.ts`, with hidden-test names from
  `verifier/ctrf.json`).
- `propose` runs an agentic proposer (Opus 5.5) on a copy of the parent harness (`src/tbench/propose.ts`).
- `screenHarnessDir` rejects edits that mention dev task names or failed hidden-test names, are oversized, or break
  the templates.
- Split: `experiments/tbench/splits/tb4.json`, 35 dev and 31 held-out tasks, stratified by category. **Only dev
  failures may inform harness changes.** The smoke task `session-window-debug` turned out to be held-out; it informed
  only the generic persistence rule in v1.

**Infrastructure** (`python/tbench/aws_infra.py`, run with the `AWS_PROFILE=<aws-profile>` prefix):

- `setup`, `launch --label L --type T [--flavor gpu] [--spot]`, `list`, `wait`, `stop`, `start`, `terminate`,
  `allow-ip --cidr`.
- Hosts are tagged `Project=tta-tbench`, and the script refuses to act on anything else.
- CPU host `<cpu-instance-id>` (us-east-1): m7i.48xlarge, 192 vCPU, 743 GB, 1.2 TB disk. Its IP changes on every
  stop or start; the latest was <cpu-host-ip>.
- GPU host `<gpu-instance-id>` (us-east-2): spot p5.4xlarge, one H100, at <gpu-host-ip>. No on-demand or spot
  p5.4xlarge capacity was available in us-east-1.
- Run jobs on a host with
  `experiments/tbench/run.sh <job> <harness-dir> <model> <dev|heldout|all> <gpu include|exclude|only> <n>`.
- Fetch results with `experiments/tbench/sync.sh <ip> <job>`, which writes `runs/tbench/<job>`.
- Summarize with `python3 experiments/tbench/summarize.py runs/tbench/<job>`.

**Offline mode (since 2026-10-14, user decision).** The account was notified that VPC Block Public
Access (BPA) is enabled by a guardrail. It was still `off` in us-east-1 and us-east-2 at the time. The user chose to
continue with **TB 4.0 offline**, and the guardrail must not be bypassed.

- Container egress is dropped on the hosts with `sudo experiments/tbench/offline.sh on`, an iptables `DOCKER-USER`
  rule on the external interface. Traffic between a task's containers, and from the host into containers, still
  works.
- The offline task set is the tasks whose reference solution passes without internet (`"offline"` in
  `experiments/tbench/splits/tb4.json`). Offline runs use `TTA_OFFLINE=1 experiments/tbench/run.sh ...`.
- Private connectivity (`python -m python.tbench.aws_infra --region R private-access`):
  - interface endpoints with private DNS for `bedrock-runtime`, `ssm`, `ssmmessages` and `ec2messages`;
  - an S3 gateway endpoint;
  - the bucket `tta-tbench-<account>-<region>`;
  - `AmazonSSMManagedInstanceCore` plus the `project-artifacts` S3 policy on the host role.
- When SSH or GitHub are blocked, use `python -m python.tbench.remote run|deploy|results <label> ...` (SSM and
  S3). `deploy` ships the local HEAD as a git bundle.
- `run.sh` exports the host's region, so the GPU host in us-east-2 calls its own Bedrock endpoint.
- Do not relaunch hosts: under BPA, Docker Hub images cannot be pulled again. All task images are cached on the two
  existing hosts.

**Terminal-Bench pitfalls so far.**

1. The SSH security group must allow the operator's egress range (`<egress-cidr>`): several egress IPs are in use, so
   a /32 times out.
2. Task names need the `terminal-bench/` prefix in `-i` filters.
3. Harbor's Docker no-network support (`allow_internet = false`, used by 2 tasks) depends on an alpine kernel probe
   with a 30 s timeout. Under heavy image pulls it timed out, and the trials failed with "no-network is not
   supported". The bootstrap now pre-pulls the probe image.
4. pi's Bedrock auth does not detect EC2 instance roles; this is why the `tta-instance` credential_process profile
   exists.
5. The `cad-model` oracle fails on today's PyPI, because `build123d==0.10.0` pulls `ocp_gordon` 0.3.1, which needs
   `OCP.collections`. This is upstream drift, not our environment.
6. Never pipe `npm run check` or `npm test` into `tail` inside an `&&` chain: the pipe hides the failure, and a
   commit went in with a tsc error once.
7. **Harbor's Docker exec merges stderr into stdout** (`stderr=asyncio.subprocess.STDOUT`). The first bash wrapper
   printed its status to stderr, so every command looked like a timeout. The first `v0-sonnet` and `v1-sonnet` runs
   were killed and discarded for this reason. The status is now the last line of stdout, and
   `test/tbench-remote.test.ts` covers merged streams.
8. Docker Hub allows anonymous pulls at 100 per hour per IP. With 132 images, prefer resizing a host that already
   has them (stop, modify-instance-attribute, start) over launching a new one.
9. **Tool layer self-test.** `--ak self_test=true --disable-verification` makes no model calls and checks streams,
   exit codes, timeouts, background jobs, truncation, file transfer and MCP in every task image. Run it on a host
   before any paid run; it passed on 62 of 63 images, and the remaining failure was a flaky sidecar start.
10. **docker cp broke tasks with non-root users** (`USER nobody`, `USER agent`): the files came out root-owned with
    mode 0600. Uploads and downloads now go through exec as the task's default user (chunked base64,
    `python/tbench/harbor_agent.py`).
11. **Tasks with skills or MCP servers** (`cumulative-layout-shift`, `medical-claims-processing`) fail unless the
    agent declares `capabilities = AgentCapabilities(skills=True, mcp_servers=True)`.
    - Skills are listed in the first message.
    - MCP over SSE connects from the host to the sidecar's container IP, which is resolved with `getent` in the main
      container. The original Host header is kept (`src/tbench/mcp.ts`).
12. **Harbor patches** (`python/tbench/harbor_patches.py`, applied when Harbor imports the agent):
    - the egress-control kernel probe is retried and its success cached;
    - verifier logs are chowned to the host user before the reward is read. Without this, `fp8-rmsnorm-gemm` raised
      a PermissionError although its tests had passed.
13. Harbor retries: run benchmark jobs with `--max-retries 2 --retry-include RuntimeError`, which retries
    environment start failures such as flaky sidecars.
14. The Bash tool caps a single call at 10 minutes, so poll long waits in steps of 280 s or less.

15. **Silently truncated replies (the largest bug so far).** In v0 and v1, 5 of 28 and 6 of 18 offline sessions
    ended on an assistant message with `stopReason: "length"`. pi treats a reply without tool calls as the end of
    the turn, so the agent stopped mid-task with "completed". There were two causes:
    - The 400k effective `contextWindow` override clamped the output to the room left in the window (1 to 12k
      tokens), while compaction never triggered.
    - At max effort the model sometimes thought for all 128k output tokens.

    pi recovers a truncated reply only once per run, and never when the output reached its limit. The fixes, in v2
    and later:
    - use the model's real window, with `reserveTokens` 600000 so compaction triggers at about 400k;
    - harness-level `continueTruncated` (`maxLengthRecoveries`), which compacts first when the context is large;
    - review issues written before the `VERDICT:` line are no longer dropped.
16. `pkill -f <pattern>` over SSH can match the SSH command's own command line and kill it. Anchor the pattern:
    `pkill -f "^node .*main.ts"`.
17. A non-root `iptables -C` fails, so `offline.sh status` without sudo read "online". The script now requires root.
18. The Mac's egress IP can change (it moved to <client-ip>). If SSH times out, check with
    `curl checkip.amazonaws.com` and `aws_infra allow-ip` before suspecting BPA.

19. **Queue scripts.**
    - Editing a running bash script with `sed -i` does not stop it, because bash keeps reading the original file.
    - A `while pgrep -f "<pattern>"` guard whose own command line contains the pattern matches itself and never
      exits.
    - Wait on a process ID, or on a pattern the waiting command does not contain.
20. **Opus 5.5's content filter on Bedrock.** Replies stop with `content_filtered` on some security, cryptography
    and biology tasks:
    - `formal-crypto` and `uefi-bootkit` are blocked at the first message;
    - `atrx-vep-crispr`, `html-js-filter`, `kv-live-surgery` and `shadow-relay` are blocked mid-run;
    - retries do not help once the filter triggers.

    Sonnet 5.5 is rarely affected. Use `--ak fallback_model=global.anthropic.claude-sonnet-5-5` (the run switches
    models after a blocked reply) and `experiments/tbench/filtered.py <job>` to find runs that ended on a blocked
    reply. Report both the Opus-only score and the score with fallback.

**Status at writing (2026-10-15, after the Opus run).**

- **Harness loop (Sonnet 5.5, offline, dev only):** v0 to v7, with notes in `experiments/tbench/history.md` and
  each `CHANGES.md`. The best is **v6**: v3's failure-pattern guidance, v5's judgment-call tie-breakers, and v4's
  reviewer with a targeted checklist. v7 (the test designer) was rejected.
- **Full offline CPU set, 46 tasks, 1 trial each:**

  | Configuration | Score |
  |---|---|
  | v0 + Sonnet | 0.630 (dev 0.773, held-out 0.500), $546 |
  | v6 + Sonnet | **0.696** (dev 0.727, held-out 0.667), $1,203 |
  | v6 + Opus 5.5, Opus only | 0.587, $1,120 |
  | v6 + Opus 5.5 with Sonnet fallback on blocked replies | 0.652 (the 6 filtered tasks re-run as `v6-opus-fb-1`, 3 of 6 solved) |

  None of these is leaderboard-comparable (online, 66 tasks, 5 trials: 64.85% is the SOTA).
- **Was running at writing:**
  - `v6-opus-hard`: Opus with v6 on the 8 hard dev tasks, 2 trials each, the baseline for Opus-specific tuning.
  - GPU host: `v6-full-gpu` (Sonnet), then `v6-opus-1-gpu`, through `~/gpu-queue-3.sh` and `~/gpu-queue-4.sh`.
  - The user was asked whether to stop these.
- **Open user decisions:** an online run (BPA is still `off`; about $1.7k for 1 trial per task, about $8k for 5),
  Opus-specific tuning (about $300 to 400 per round), or stop. Also a budget cap. Total Bedrock spend so far is
  about $7k. The /goal was cleared by the user.
- **Tools:** `experiments/tbench/{run.sh, sync.sh, summarize.py, compare.ts, wait.sh, split.py, offline.sh,
  harbor.sh, filtered.py, check-model.ts}`. Use `TTA_TASKS="a b"` for explicit task lists, `TTA_OFFLINE=1` for the
  offline set, and `--ak fallback_model=...` for the fallback.
