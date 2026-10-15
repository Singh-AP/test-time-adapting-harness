# test-time-adapting-harness

**A coding-agent harness that improves itself from its own failures.** It turns the
[pi](https://github.com/earendil-works/pi) coding agent into a [Terminal-Bench](https://www.tbench.ai/) agent. An
agentic proposer reads failure reports from development tasks and rewrites the harness: its prompts, review loop and
recovery logic. The repository also implements the general method, *Harness Learning Enables Generalizable
Test-Time Adaptation* (Zhang et al., arXiv:2609.35738), for reasoning and question-answering tasks.

## What this harness improves

### Terminal-Bench 4.0: +17 points on tasks it never saw

The two runs use the same model (Claude Sonnet 5.5 at max effort), the same tasks and one trial per task. Only the
harness differs:

| Harness | Held-out tasks (24) | Dev tasks (22) | All (46) |
|---|---|---|---|
| v0: a prompt, an environment probe and one finish check | 0.500 | 0.773 | 0.630 |
| **v6: this harness** | **0.667** | 0.727 | **0.696** |

- **Held-out tasks** never reached any report, proposal or harness decision, so their gain measures generalization
  rather than tuning.
- **Dev tasks** were already near the model's ceiling, and their difference is within run-to-run noise.
- **Offline runs.** Task containers had no internet access, which leaves the 46 CPU tasks whose reference solutions
  pass without it. The scores are not comparable with the public leaderboard, which runs online on 66 tasks with 5
  trials. Details are in [results/tbench-offline.md](results/tbench-offline.md).

What changed between v0 and v6, and why each piece is there:

1. **Cut-off replies no longer end the run.**
   - The problem: in the first runs, 5 of 28 and 6 of 18 sessions ended on a reply cut off by the output limit.
     pi treats a reply without tool calls as the end of the turn, so the agent stopped mid-task and reported
     success.
   - The fix: the harness detects a truncated reply, compacts the context first when it is large, and tells the
     model to continue, up to 6 times.
   - It also uses the model's full 1M-token window, with compaction near 400k tokens. Before, a window override
     had left as little as 1k tokens of room for output.
2. **Guidance on how hidden tests are usually failed.** An agentic proposer (Claude Opus 5.5) read the dev-task
   failure report and wrote six rules into the system prompt:
   - treat "infeasible", a missing credential or a near miss as a sign of a remaining bug;
   - use every provided input;
   - settle each judgment call with evidence;
   - expect the tests to substitute other inputs;
   - apply fixes where the task requires, not in a scratch area;
   - use the time budget instead of stopping with known gaps.
3. **Tie-breakers for judgment calls.** A second proposal found that agents named the right alternative as a
   "judgment call", then picked the wrong one. The harness now says how to choose:
   - the reading under which the task's goal works out;
   - the field's standard method;
   - the general case over a simplifying assumption;
   - the strict reading of a prohibition.
4. **An independent reviewer with a targeted checklist.** When the agent stops, a fresh session audits the container
   against the task statement and sends evidence-backed problems back, for up to two rounds. It may write only
   under `/tmp/review`. A generic reviewer passed 16 of 18 trials, failed ones included. With a checklist of the
   same failure patterns, the reviewer started catching real problems.
5. **A finish audit.** The first two times the agent stops, it must list every caveat, unused input and judgment
   call in its work, then resolve each one. If the summary would still need a limitations section, it is not done.
6. **A fallback model when the provider blocks a reply.** Claude Opus 5.5's content filter on Amazon Bedrock blocked
   replies on 6 of 46 tasks (security, cryptography and biology topics). With `--ak fallback_model=...` the run
   switches models instead of ending; this recovered 3 of the 6.
7. **A tool layer built for task containers.**
   - The agent and its credentials stay on the host. Only commands run in the container, through Harbor's
     environment API.
   - Each bash command runs as a script under `timeout`, with stdin from `/dev/null` and its output in a log file.
   - The tool returns the head and tail of the output, with the exit status as the last line of stdout. Harbor
     merges stderr into stdout, so a status on stderr would be lost.
   - Files are copied through `exec` as the task's own user. `docker cp` left root-owned files that non-root tasks
     could not read.
   - Task-provided skills and MCP servers are supported.

Changes that did not help, kept for the record:

- **A test designer** that predicts the hidden tests before the agent starts (v7) scored 0.33 on the hardest dev
  tasks against v6's 0.67. Its predictions were sometimes wrong, and the agent treated them as requirements.
- **A reviewer without the checklist** passed almost everything.
- **Opus 5.5 with the same harness** scored 0.587 on all 46 tasks. On the hardest dev tasks it matched Sonnet 5.5
  task for task.

The versions and their change notes are in [harnesses/tbench/](harnesses/tbench/), and the process is in
[docs/terminal-bench.md](docs/terminal-bench.md).

### Harness Learning on reasoning and QA tasks

In these runs, a proposer model edits a JavaScript harness around a frozen solver (Qwen3-32B). Held-out questions
are never shown to the proposer or used for selection.

| Benchmark | Seed harness | Adapted | Proposer |
|---|---|---|---|
| Reasoning Gym, 8 families, 5 rounds | 0.201 | 0.907 | Claude Opus 5.5, $1.64 |
| Reasoning Gym, 8 families, 5 rounds | 0.199 | 0.891 | Claude Haiku 4.5, $0.50 |
| HotpotQA, 6 rounds | 0.453 | 0.547 (peak 0.560) | Claude Opus 5.5 |
| MuSiQue, 6 rounds | 0.273 | 0.260 (peak 0.420) | Claude Opus 5.5 |
| 2WikiMultihopQA, 6 rounds | 0.500 | 0.653 (peak 0.680) | Claude Opus 5.5 |

- **Noisy selection.** MuSiQue's last round advanced to a worse candidate, because the QA protocol picks the best
  of 4 candidates on only 32 scoring questions.
- **Agentic proposer.** A pi session that can test its revisions on feedback questions adapts faster than a
  single-shot proposer: 0.753 against 0.614 after one round.
- **Transfer.** A playbook distilled from earlier runs raised a weak proposer's gain on unseen families from +0.023
  to +0.101.

See [docs/harness-learning.md](docs/harness-learning.md) and [results/](results/).

## Quick start

You need Node.js 22.19 or newer, Python 3.12 ([uv](https://docs.astral.sh/uv/) recommended) and, for
Terminal-Bench, Docker.

```bash
git clone https://github.com/Singh-AP/test-time-adapting-harness.git
cd test-time-adapting-harness
scripts/install.sh    # Node packages, .venv-harbor (Harbor) and .venv (reasoning-gym); `tbench` or `learning` for one
```

### Choose a model

Write models as `provider/model-id`, for any [pi-ai](https://github.com/earendil-works/pi) provider. Credentials come
from the provider's usual environment variable. A bare model id is an Amazon Bedrock model and uses the AWS
credential chain.

| Provider | Model argument | Credentials |
|---|---|---|
| Anthropic | `anthropic/claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5.5` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter/anthropic/claude-sonnet-5.5` | `OPENROUTER_API_KEY` |
| Amazon Bedrock | `global.anthropic.claude-sonnet-5-5` | an AWS profile or environment credentials |

```bash
node scripts/check-model.ts anthropic/claude-sonnet-5-5    # one short completion
```

### Run Terminal-Bench

```bash
# Check the tool layer in 4 task containers, without model calls
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 --ak self_test=true --disable-verification -l 4 -n 4

# One task (names are listed in experiments/tbench/splits/tb4.json), then the whole benchmark
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -i terminal-bench/cargo-flight-dispatch
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -n 8 --max-retries 2 --retry-include RuntimeError
```

`scripts/tbench.sh` runs Harbor with this agent and the v6 harness. `--harness <dir>` selects another harness. Other
options go to `harbor run`, including these agent options:

| Option | Effect |
|---|---|
| `--ak thinking=<level>` | Overrides the harness thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `--ak fallback_model=<model>` | Switches to this model after a reply the provider blocked |
| `--ak time_budget_sec=<s>` | Agent time budget; the default is the task's timeout |
| `--ak aws_profile=<name>` | AWS profile for Bedrock when `AWS_PROFILE` is unset |

Each trial writes these files to `jobs/<job>/<trial>/agent/`:

- `transcript.md`;
- `agent-result.json`: the stop reason, finish checks, recoveries, reviews, tokens and cost;
- `session.jsonl`;
- one `review-N.md` per reviewer round.

### Improve the harness from your own runs

```bash
node src/tbench/cli.ts report --jobs jobs/<job>          # execution report from dev-split trials only
node src/tbench/cli.ts propose --parent harnesses/tbench/v6 --jobs jobs/<job> --out harnesses/tbench/v8 \
  --proposer anthropic/claude-opus-5-5
node experiments/tbench/compare.ts v6=jobs/<job> v8=jobs/<new-job>    # paired, per-task comparison
```

The proposer edits a copy of the parent harness. Edits that name a dev task or a failed hidden test are rejected,
so the harness cannot memorize. The split in `experiments/tbench/splits/tb4.json` keeps held-out tasks out of every
report.

### Adapt a harness for reasoning or QA tasks

```bash
node src/cli.ts adapt --task rg:maze --rounds 5 --solver <model> --proposer anthropic/claude-opus-5-5
node src/cli.ts --help
```

### Use it from pi

The repository is a pi package. Loaded into a pi session from the clone, it adds an `adapt_harness` tool and the
`/adapt` and `/harness-runs` commands:

```bash
node_modules/.bin/pi -e ./src/pi/extension.ts
```

## How it works

```
 host                                                  task container (Docker)
 ┌─────────────────────────────────────────┐          ┌─────────────────────────────┐
 │ Harbor                                  │          │                             │
 │  └ PiHarnessAgent (python/tbench) ◀─────┼── exec ─▶│ bash: scripts under timeout │
 │        ▲ JSON lines on stdin/stdout     │          │ files: read and written as  │
 │        ▼                                │          │ the task's own user         │
 │  pi session (src/tbench)                │          │ no model credentials        │
 │   harness prompts, finish audit,        │          └─────────────────────────────┘
 │   reviewer session, recoveries ─────────┼──▶ model provider API
 └─────────────────────────────────────────┘
```

A Terminal-Bench harness is a directory. The adaptation loop may change any of its files:

| File | Role |
|---|---|
| `system.md` | System prompt: how to work, how hidden tests are usually failed, tie-breakers |
| `user.md` | First message, with `{{instruction}}`, `{{environment}}` and `{{time_budget}}` |
| `probe.sh` | Environment snapshot (OS, tools, cgroup limits) for the first message |
| `finish.md` | Audit prompt sent when the agent stops |
| `review.md`, `review-request.md`, `review-followup.md` | The independent reviewer and its hand-off |
| `harness.json` | Thinking level, finish checks, bash limits, context window, compaction, time warnings, review rounds, recovery limits |

## Repository

| Path | Contents |
|---|---|
| `src/tbench/` | The Terminal-Bench agent: session loop, container tools, bridge, MCP, self-test, report and proposer |
| `python/tbench/` | The Harbor agent, Harbor patches, and optional AWS runner hosts |
| `harnesses/tbench/` | Harness versions v0 to v7, each with `CHANGES.md` |
| `experiments/tbench/` | Benchmark runs, summaries, comparisons, the dev/held-out split, offline mode |
| `src/core/`, `src/proposers/`, `src/tasks/` | The Harness Learning engine, proposers and tasks |
| `src/pi/` | The pi package |
| `scripts/` | `install.sh`, `tbench.sh`, `check-model.ts` |
| `results/` | Result tables for every experiment |
| `docs/` | [Terminal-Bench guide](docs/terminal-bench.md), [Harness Learning guide](docs/harness-learning.md), [development notes](docs/development.md) |

## Safety

- **Model credentials** never enter task containers. The agent runs on the host, and only its commands run inside.
- **Harness code written by a proposer** runs only in a QuickJS sandbox, with no filesystem, network, process or
  timers.
- **Solver-written Python** runs through a guard (`python/guard.py`): a scrubbed environment, resource limits and an
  audit hook that blocks sockets, subprocesses and file access outside a scratch directory. This is defense in
  depth, not a security boundary, so use a container for untrusted settings.

## Tests

```bash
npm test && npm run check && npm run test:py
```

## License

MIT
