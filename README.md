# agent-harness-learning

**A coding-agent harness that gets better from its own failures.** It runs the [pi](https://github.com/earendil-works/pi)
coding agent on [Terminal-Bench](https://www.tbench.ai/) with any model provider. When the agent fails, a second agent
reads the failure reports and rewrites the harness, meaning the agent's prompts, self-checks, reviewer and settings.
The model itself never changes.

With the same model on the same tasks, the learned harness solves **67%** of held-out Terminal-Bench 4.0 tasks,
against **50%** for the starting harness ([details](#results)).

- **A ready-to-run Terminal-Bench agent** (`harnesses/tbench/v6`):
  - it recovers replies cut off by the output limit;
  - it audits its own work before finishing;
  - an independent reviewer checks the result against how hidden tests usually fail;
  - it can switch to a fallback model when a provider blocks a reply.
- **Harness learning on your own runs.** One command builds a failure report from your trials. A second has a
  proposer agent edit the harness, and edits that would memorize task names or test names are rejected.
- **Any model provider:** Anthropic, OpenAI, OpenRouter, Amazon Bedrock and the other pi-ai providers.
- **Credentials stay on the host.** Only the agent's commands run in the task's container.
- **Beyond Terminal-Bench**, the same loop adapts harnesses for reasoning and question-answering tasks. This is an
  implementation of [Harness Learning](https://arxiv.org/abs/2609.35738) (Zhang et al.).

## Requirements

- Node.js 22.19 or newer
- Python 3.12, with [uv](https://docs.astral.sh/uv/) recommended
- Docker, to run Terminal-Bench tasks. The results below were measured on x86-64 Linux hosts.
- A model: an API key for Anthropic, OpenAI or OpenRouter, or AWS credentials for Amazon Bedrock

## Install

```bash
git clone https://github.com/Singh-AP/agent-harness-learning.git
cd agent-harness-learning
scripts/install.sh
```

This installs the Node packages and two Python environments:

- `.venv-harbor`, with [Harbor](https://github.com/harbor-framework/harbor), the Terminal-Bench runner;
- `.venv`, with Reasoning Gym, for the harness-learning tasks.

Use `scripts/install.sh tbench` or `scripts/install.sh learning` to install only one of them.

## Quick start

```bash
# 1. Make a model reachable and check it
export ANTHROPIC_API_KEY=...
node scripts/check-model.ts anthropic/claude-sonnet-5-5

# 2. Check Docker and the agent's tools in two task containers (no model calls; the first run pulls the images)
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 --ak self_test=true --disable-verification -l 2

# 3. Solve one task (about 40 minutes and $5 with Claude Sonnet 5.5)
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -i terminal-bench/coq-block-bound --job-name first-run

# 4. See the result
python3 experiments/tbench/summarize.py jobs/first-run
```

The agent's full session is in `jobs/first-run/<trial>/agent/transcript.md`.

## Choosing a model

Pass models as `provider/model-id`. Credentials come from each provider's usual environment variable.

| Provider | `-m` value | Credentials |
|---|---|---|
| Anthropic | `anthropic/claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5.5` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter/anthropic/claude-sonnet-5.5` | `OPENROUTER_API_KEY` |
| Amazon Bedrock | `amazon-bedrock/global.anthropic.claude-sonnet-5-5`, or the bare id | an AWS profile (`AWS_PROFILE`) or environment credentials |

Other providers built into [pi-ai](https://github.com/earendil-works/pi) work the same way, for example Google,
Mistral, Groq, xAI and DeepSeek.

The v6 harness thinks at `max` effort. Pass `--ak thinking=high` (or lower) for cheaper and faster trials.

## Running Terminal-Bench

`scripts/tbench.sh` runs Harbor with this agent and the v6 harness on Terminal-Bench 4.0. Its own options are
`-m <model>`, which is required, and `--harness <dir>`. Everything else goes to `harbor run`:

| Option | Effect |
|---|---|
| `-i terminal-bench/<task>` | Run one task (repeatable). Task names are listed in `experiments/tbench/splits/tb4.json` |
| `-l <n>` | Run at most `n` tasks |
| `-n <n>` | Concurrent trials. Each trial runs its own containers, so size this to your machine |
| `-k <n>` | Trials per task |
| `--job-name <name>`, `-o <dir>` | Job name, and the output directory (default `jobs/`) |
| `--max-retries 2 --retry-include RuntimeError` | Retry trials whose environment failed to start |
| `--ak thinking=<level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `--ak fallback_model=<model>` | Switch to this model after a reply the provider blocked |
| `--ak time_budget_sec=<s>` | Agent time budget; the default is the task's own timeout |
| `--ak aws_profile=<name>` | AWS profile for Bedrock, when `AWS_PROFILE` is unset |
| `--ak self_test=true --disable-verification` | Check the tool layer only, with no model calls |

Each trial writes these files to `jobs/<job>/<trial>/agent/`:

| File | Contents |
|---|---|
| `transcript.md` | The readable session: prompts, tool calls, outputs, reviews |
| `agent-result.json` | Stop reason, turns, tokens, cost, finish checks, recoveries, reviewer verdicts |
| `review-N.md` | Each independent review |
| `session.jsonl` | The raw pi session |

`python3 experiments/tbench/summarize.py jobs/<job>` prints per-task reward, cost, time and reviewer verdicts.

**Cost and time.** With v6 and Claude Sonnet 5.5, a trial averaged $26 and 3.5 hours, against the 8-hour task
budget. Three tasks need an NVIDIA H100.

## Improving a harness from your runs

```bash
cp -r harnesses/tbench/v6 harnesses/tbench/mine
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 --harness harnesses/tbench/mine --job-name mine-1 -k 2 \
  -i terminal-bench/<dev-task> -i terminal-bench/<dev-task>
node src/tbench/cli.ts report --jobs jobs/mine-1                      # what failed, and why
node src/tbench/cli.ts propose --parent harnesses/tbench/mine --jobs jobs/mine-1 \
  --out harnesses/tbench/mine-2 --proposer anthropic/claude-opus-5-5  # an agent edits a copy
node experiments/tbench/compare.ts mine=jobs/mine-1 mine-2=jobs/mine-2   # after running mine-2 the same way
```

- **Dev tasks only.** Reports and proposals use only the dev tasks in `experiments/tbench/splits/tb4.json`. Keep
  the held-out tasks for your final comparison, so that the improvement you measure is real.
- **No memorizing.** The proposer edits a copy of the parent harness and writes a `CHANGES.md` with its diagnosis.
  A proposal that names a dev task or a failed hidden test is rejected.
- **Noise.** Single trials are noisy: about 1 in 4 dev tasks flips between runs of the same harness. Compare with
  at least 2 trials on the tasks that differ.

## Writing your own harness

A harness is a directory, so editing files is all it takes:

| File | Role |
|---|---|
| `system.md` | System prompt |
| `user.md` | First message, with `{{instruction}}`, `{{environment}}` and `{{time_budget}}` |
| `probe.sh` | Shell script whose output (OS, tools, CPU and memory limits) fills `{{environment}}` |
| `finish.md` | Sent when the agent stops; it asks the agent to verify its work before finishing |
| `review.md`, `review-request.md`, `review-followup.md` | The independent reviewer; delete `review.md` to turn the reviewer off |
| `harness.json` | Thinking level, finish checks, bash limits, context window, compaction, time warnings, review rounds, recovery limits |

All the settings and their defaults are in [docs/terminal-bench.md](docs/terminal-bench.md#the-harness-format).

## Harness learning for reasoning and QA tasks

```bash
node src/cli.ts adapt --task rg:maze --rounds 5 --solver <model> --proposer anthropic/claude-opus-5-5
node src/cli.ts eval --task rg:maze --harness runs/<run>/final.js --solver <model>
node src/cli.ts --help
```

Here the harness is a JavaScript program around a solver model, run in a sandbox. The loop adapts it to a task
family from feedback questions, and scores it on held-out questions it never saw. Tasks include any
[Reasoning Gym](https://github.com/open-thought/reasoning-gym) family (`rg:<family>`) and multi-hop QA (`qa:hotpotqa`,
`qa:musique`, `qa:2wiki`). See [docs/harness-learning.md](docs/harness-learning.md).

From [pi](https://github.com/earendil-works/pi), `node_modules/.bin/pi -e ./src/pi/extension.ts` adds an
`adapt_harness` tool and the `/adapt` and `/harness-runs` commands.

## Results

All Terminal-Bench numbers come from an offline subset of Terminal-Bench 4.0 (46 tasks whose reference solutions
pass without internet), with one trial per task and Claude Sonnet 5.5 as the agent's model. They are not comparable
with the public leaderboard.

| Harness | Held-out tasks (24) | All tasks (46) |
|---|---|---|
| v0: prompt, environment probe, one finish check | 50% | 63% |
| **v6: this harness** | **67%** | **70%** |

On Reasoning Gym, the same loop took a Qwen3-32B solver from 20% to 91% on held-out questions, averaged over 8
families.

What each change contributed, and what did not help, is in [docs/terminal-bench.md](docs/terminal-bench.md). The full
tables are in [results/](results/).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Provider is not configured: <provider>` | Set that provider's API key, or AWS credentials for Bedrock |
| `pass the agent's model: -m provider/model` | `scripts/tbench.sh` needs `-m` |
| No tasks match `-i` | Task names need the `terminal-bench/` prefix |
| A trial ends with `content_filtered` | The provider blocked a reply. Add `--ak fallback_model=<another model>` |
| A trial fails before the agent starts | The environment did not come up. Add `--max-retries 2 --retry-include RuntimeError` |
| A self-test check fails | See `jobs/<job>/<trial>/agent/selftest.json`, and check that Docker is running and has enough memory |

## Documentation

- [docs/terminal-bench.md](docs/terminal-bench.md): how the agent works, the harness format, the versions, the
  improvement loop, running at scale on AWS, and lessons learned.
- [docs/harness-learning.md](docs/harness-learning.md): the Harness Learning loop for reasoning and QA tasks.
- [docs/development.md](docs/development.md): the repository map, conventions, tests and open items.

To run the tests: `npm test && npm run check && npm run test:py`.

## Credits

- **Harness Learning:** Zhang et al., *Harness Learning Enables Generalizable Test-Time Adaptation*,
  [arXiv:2609.35738](https://arxiv.org/abs/2609.35738).
- **Built on** [pi](https://github.com/earendil-works/pi), [Harbor](https://github.com/harbor-framework/harbor) and
  [Terminal-Bench](https://www.tbench.ai/).

## License

MIT
