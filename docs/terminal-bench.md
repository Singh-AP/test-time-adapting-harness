# The Terminal-Bench agent

This guide covers how the agent works, the harness format, how to run it, and how a harness is improved from
failures. Results are in [results/tbench-offline.md](../results/tbench-offline.md).

## Results in brief

These runs use Terminal-Bench 4.0 offline (task containers without internet), one trial per task:

| Configuration | Held-out (24) | Dev (22) | All 46 CPU tasks | Cost | Mean minutes per trial |
|---|---|---|---|---|---|
| v0 + Claude Sonnet 5.5 | 0.500 | 0.773 | 0.630 | $546 | 104 |
| **v6 + Claude Sonnet 5.5** | **0.667** | 0.727 | **0.696** | $1,203 | 209 |
| v6 + Claude Opus 5.5 | 0.500 | 0.682 | 0.587 | $1,120 | 147 |
| v6 + Opus 5.5, Sonnet fallback after a blocked reply | 0.542 | 0.773 | 0.652 | | |

For reference, the public leaderboard (online, all 66 tasks, 5 trials per task) listed Claude Code with Opus 5.5 at
64.85% in October 2026. The offline scores above are not directly comparable with it.

## Architecture

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

**The Harbor agent** is `python/tbench/harbor_agent.py:PiHarnessAgent`.
- It starts `src/tbench/main.ts` as a Node process. That process holds a pi coding-agent session.
- It answers the session's `exec`, `upload` and `download` requests through Harbor's environment API, over a
  JSON-lines bridge on the process's stdin and stdout (`src/tbench/bridge.ts`). Nothing listens on a network port.
- Model calls and credentials stay on the host.
- It declares the skills and MCP-server capabilities, so tasks that provide them run.

**The tools.**
- `bash` is the harness's own tool (`src/tbench/remote.ts`):
  - Each call writes the command to a script and runs it in a fresh shell under `timeout`, with stdin from
    `/dev/null` and the output in a log file.
  - It returns the head and tail of the output, and prints the exit status last on stdout, because Harbor's
    Docker exec merges stderr into stdout.
  - Background jobs started with `nohup` survive the call.
- `read`, `edit` and `write` are pi's own tools, given remote file operations.
- Files are copied through `exec` as the task's default user, in base64 chunks, so ownership and permissions match
  what the task expects.

**The session loop** is `runTerminalAgent` in `src/tbench/agent.ts`:
1. A probe script snapshots the environment into the first message: OS, tools and cgroup CPU and memory limits.
2. Task-provided skills (from each `SKILL.md`'s front matter) and MCP servers are listed in the first message.
   MCP servers are connected over SSE from the host.
3. Time warnings tell the agent how much of the budget remains, at 50%, 75% and 90% by default.
4. **Truncation recovery** (`continueTruncated`). A reply cut off by the output limit is continued, compacting
   first when the context is above 70% of the window. A reply the provider's content filter blocked is re-prompted
   a bounded number of times. If a fallback model is configured, the session switches to it.
5. **Finish audit.** When the agent stops, the `finish.md` prompt asks it to verify every requirement and resolve
   every open judgment call, up to `maxFinishChecks` times.
6. **Independent review.** A fresh reviewer session with `bash` and `read` audits the container against the task
   statement. It may write only under `/tmp/review`. Problems written before its `VERDICT: FAIL` line go back to the
   agent, for up to `review.maxRounds` rounds, while enough time remains.

**Harbor patches** (`python/tbench/harbor_patches.py`) are applied when Harbor imports the agent:
- Harbor's nftables egress probe has a 30-second timeout. It is retried, and its first success is cached, so a
  loaded host does not fail no-network tasks.
- Verifier log directories are handed back to the host user before the reward is read. A verifier running as
  another user could otherwise leave `reward.json` unreadable.

## Running

```bash
scripts/install.sh tbench
export ANTHROPIC_API_KEY=...       # or another provider's key, or AWS credentials for Bedrock
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 --ak self_test=true --disable-verification -l 4 -n 4
scripts/tbench.sh -m anthropic/claude-sonnet-5-5 -i terminal-bench/<task> [-i ...] -n <concurrent trials>
```

- **Self-test first.** `--ak self_test=true --disable-verification` makes no model calls. In each task image it checks
  output streams, exit codes, timeouts, background jobs, truncation, file transfer both ways and MCP servers.
- **Task names** need the `terminal-bench/` prefix. All 66 are listed in `experiments/tbench/splits/tb4.json`.
- **Flaky environments.** Add `--max-retries 2 --retry-include RuntimeError` to retry environment start failures,
  such as a sidecar that does not come up.
- **Cost and time.** With v6, Sonnet 5.5 cost about $26 per trial and took 3.5 hours on average, out of the 8-hour
  budget. Opus 5.5 cost about $24 per trial and took about 2.5 hours. The reviewer and the prompts that push the
  agent to use its time budget roughly double v0's cost.
- **GPU tasks.** Three tasks need an H100 (`fp8-rmsnorm-gemm`, `jax-speedrun-gpu`, `math-eval-grader`).
- **Agent options** (`--ak key=value`):

  | Option | Default | Effect |
  |---|---|---|
  | `harness` | `harnesses/tbench/v6` through the wrapper | Harness directory, relative to the repository |
  | `thinking` | the harness's level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
  | `time_budget_sec` | the task's agent timeout | Wall-clock budget the agent is told about and held to |
  | `fallback_model` | none | Model (same form as `-m`) to switch to after a reply the provider blocked |
  | `aws_profile` | none | AWS profile for Bedrock when `AWS_PROFILE` is unset |
  | `self_test` | `false` | Tool-layer checks only, no model calls |
  | `node` | `node` | Node.js executable |

- **Outputs.** Each trial writes these files to `jobs/<job>/<trial>/agent/`:
  - `transcript.md`, the readable session;
  - `session.jsonl`, the raw pi session;
  - `agent-result.json`: the stop reason, turns, tool calls, tokens, cost, finish checks, length recoveries,
    fallback use and reviews;
  - `review-N.md`, one per reviewer session;
  - `agent-stderr.log`.
- **Summaries.**
  - `python3 experiments/tbench/summarize.py jobs/<job>` prints per-task rewards, costs, minutes, turns, stop
    reasons and review verdicts, split into dev and held-out. A trial that errored counts as 0.
  - `python3 experiments/tbench/filtered.py jobs/<job>` lists trials that ended on a blocked reply.

## The harness format

A harness is a directory loaded by `src/tbench/harness.ts`. Files and settings left out fall back to the defaults.

| File | Contents |
|---|---|
| `system.md` | System prompt |
| `user.md` | First message; `{{instruction}}`, `{{environment}}` and `{{time_budget}}` are filled in |
| `probe.sh` | Runs in the container before the first turn; its output becomes `{{environment}}` |
| `finish.md` | Sent when the agent stops; empty disables the finish audit |
| `review.md` | Reviewer system prompt; its presence enables the reviewer |
| `review-request.md` | Reviewer's first message (`{{instruction}}`, `{{summary}}`, `{{time_left}}`) |
| `review-followup.md` | Sent to the agent after a failed review (`{{issues}}`, `{{time_left}}`) |
| `designer.md` | Optional test designer that predicts the hidden tests (used only in v7) |
| `harness.json` | Settings, below |

| Setting | Default | v6 |
|---|---|---|
| `thinkingLevel` | `high` | `max` |
| `maxFinishChecks` | 1 | 2 |
| `bash` | 600 s default timeout, 3,600 s maximum, 12 kB head, 24 kB tail | same |
| `contextWindow` | 400,000 | 1,000,000 |
| `compaction` | enabled, `reserveTokens` 32,000, `keepRecentTokens` 60,000 | `reserveTokens` 600,000 (compacts near 400k), `keepRecentTokens` 80,000 |
| `timeWarnings` | 0.5, 0.75, 0.9 | same |
| `review` | 2 rounds, skipped when less than 600 s remain | 2 rounds, 900 s |
| `maxLengthRecoveries` | 6 | 6 |
| `maxFilterRetries` | 3 | 3 |
| `continuePrompt`, `filteredPrompt` | built in | built in |

### Versions

| Version | Change | Dev result (hard tasks) |
|---|---|---|
| v0 | Prompt, environment probe, one finish check | 17 of 22 dev tasks |
| v1 | v0, an independent reviewer and a persistence prompt | stopped: a truncation bug hid the effect |
| v2 | v0 with the engineering fixes: truncation recovery, the real 1M window with compaction near 400k, a cgroup-aware probe | 16 of 22 dev tasks (noise) |
| v3 | A proposer edit of v2: how hidden tests are usually failed, a stricter finish audit, 2 finish checks | the three always-failing tasks still fail |
| v4 | v3, plus the reviewer with a targeted checklist | 0.58 |
| v5 | A proposer edit of v3: tie-breakers for judgment calls | 0.50 |
| **v6** | v5, plus the v4 reviewer | **0.67** |
| v7 | v6, plus an independent test designer | 0.33, rejected |

Each directory has a `CHANGES.md` with the diagnosis and change manifest. `experiments/tbench/history.md` holds
the dev-only history that the proposer sees.

## Improving a harness

The loop follows Harness Learning: reports and proposals use development tasks only, and held-out tasks are only
reported.

1. **Split.** `experiments/tbench/splits/tb4.json` holds 35 dev and 31 held-out tasks, stratified by category, plus
   the GPU tasks and the 49 offline-solvable tasks. `experiments/tbench/split.py` builds and selects from it.
2. **Run** the parent harness on the dev tasks.
3. **Report.** `node src/tbench/cli.ts report --jobs <job-dir>...` builds an execution report. It covers rewards,
   the names of failed hidden tests (from the verifier's `ctrf.json`), the verifier output, the agent's final
   summary, review verdicts and the transcript tail of every dev trial.
4. **Propose.** `node src/tbench/cli.ts propose --parent <dir> --jobs <job-dir>... --out <new-dir> --proposer
   <model> [--history experiments/tbench/history.md]` starts an agentic proposer session (`src/tbench/propose.ts`)
   on a copy of the parent. The proposer diagnoses failure patterns and edits the files.
5. **Screen.** `screenHarnessDir` rejects a proposal that:
   - names a dev task or a failed hidden test (so the harness cannot memorize);
   - grows the prompts past a size limit;
   - breaks a template.
6. **Compare.** Run the parent and the candidate on the dev tasks that are not solved every time, with at least 2
   trials each, and compare with `node experiments/tbench/compare.ts parent=<job> candidate=<job>`. About 5 of 22
   dev tasks flip between runs of the same harness, so one-trial differences of a task or two are noise.
7. **Report held-out** results only for the final choice.

## Running at scale on AWS (optional)

A full pass takes hours per trial, so the experiments ran on EC2 runner hosts (`python/tbench/aws_infra.py`; run
it with your own AWS profile):

```bash
python -m python.tbench.aws_infra setup                 # instance role, security group, key pair
python -m python.tbench.aws_infra launch --label dev --type m7i.48xlarge --disk 1200
python -m python.tbench.aws_infra launch --label gpu --type p5.4xlarge --flavor gpu --spot
python -m python.tbench.aws_infra allow-ip              # SSH from your current IP only
python -m python.tbench.aws_infra list | wait <id> | stop <id> | start <id> | terminate <id>
```

- **Host design.**
  - The instance role may only invoke Bedrock models.
  - IMDSv2 is required, with hop limit 1, so task containers cannot reach the role.
  - pi's Bedrock client does not detect instance roles, so `bootstrap.sh` writes an AWS profile whose
    `credential_process` reads them (`python/tbench/imds_credentials.py`).
  - Hosts are tagged, and the script refuses to stop, start or terminate anything without its tag.
- **Jobs.**
  - `experiments/tbench/run.sh <job> <harness> <model> <dev|heldout|all> <gpu include|exclude|only> <n>` runs a
    split.
  - `TTA_TASKS="a b"` runs exact tasks, and `TTA_OFFLINE=1` runs the offline set.
  - `experiments/tbench/sync.sh <host> <job>` copies the results to `runs/tbench/<job>`.
- **Offline mode.**
  - `sudo experiments/tbench/offline.sh on` drops container internet traffic with an iptables `DOCKER-USER` rule.
    Traffic between a task's containers and from the host into containers still works.
  - The offline task set holds the 49 tasks whose reference solution passes this way.
- **Private networking.** `python -m python.tbench.aws_infra --region <r> private-access` adds:
  - interface endpoints for Bedrock and SSM, and an S3 gateway endpoint;
  - a private artifact bucket with all public access blocked.

  With these, a host works without public internet. `python -m python.tbench.remote run|deploy|results <label>`
  then controls hosts through SSM and S3 instead of SSH.
- **Images.** Docker Hub limits anonymous pulls to 100 per hour per IP, and the dataset has 132 images. Resize a host
  that has them cached (stop, change the instance type, start) rather than launching a new one.

## Lessons learned

1. **Check the tool layer before spending on models.** The self-test caught every container-level bug below before
   a paid run would have.
2. **Merged output streams.** Harbor's Docker exec merges stderr into stdout. A status line on stderr made every
   command look like a timeout. Print the status last on stdout.
3. **`docker cp` and non-root tasks.** Copied files came out root-owned with mode 0600, and tasks running as
   `nobody` or `agent` could not read them. Copy through `exec` as the task's user.
4. **Capabilities.** Tasks that ship skills or MCP servers fail unless the agent declares those capabilities.
5. **Silent truncation was the largest bug.** pi ends the turn on a reply without tool calls, including a reply cut
   off by the output limit. Check the stop reason and continue. Give compaction room: a window override that is too
   tight squeezes output to nothing before compaction triggers.
6. **Generic reviewers rubber-stamp.** A reviewer asked only to check the work passed 16 of 18 trials, failed ones
   included. One with a checklist of concrete failure patterns found real problems.
7. **Prompt rules do not fix everything.** Three dev tasks failed in every version and every trial, with Sonnet and
   with Opus. Their transcripts show the agent reading the guidance and reasoning its way around it.
8. **Predicting hidden tests can hurt.** The agent treated wrong predictions as requirements (v7).
9. **Provider content filters.** Some providers block replies on security, cryptography or biology tasks, and
   retries rarely help. Use a fallback model, and report scores with and without it.
10. **Upstream drift.** One task's reference solution fails on today's PyPI (`cad-model`: `build123d` pulls an
    incompatible dependency), so check the oracle before blaming the agent.
