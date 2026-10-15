# Development notes

## Repository map

| Path | What it is |
|---|---|
| `src/core/types.ts`, `usage.ts` | Task, Question, outcomes, traces, and the client interfaces (Solver, Proposer, Python, Search) |
| `src/core/capabilities.ts` | The globals a harness can call (`llm`, `python`, `search`, `log`), with per-question budgets and tracing |
| `src/core/sandbox.ts` | `runHarness()`: one pi-codemode QuickJS VM per question |
| `src/core/executor.ts` | `evaluateHarness()` computes J(h;Q); `classifyOutcome()` |
| `src/core/edits.ts` | SEARCH/REPLACE blocks, full-file code blocks and `NO_CHANGE`; exact, then whitespace-tolerant matching |
| `src/core/screens.ts` | Static rejection before execution: size, line count, hard-coded answers, question text, loads in QuickJS |
| `src/core/report.ts` | Execution report (paper App. E.2): scores, failure traces, diff from the previous harness, history |
| `src/core/prompts.ts`, `proposer.ts` | Single-shot proposer: system and revision prompts, retries with error feedback |
| `src/core/select.ts`, `reward.ts` | Greedy (Eq. 7) and best-of-G (App. D.3) selection; rewards (Eq. 8, 11); GRPO group advantages |
| `src/core/loop.ts`, `independent.ts`, `store.ts` | The Eq. 4 loop with artifacts and resume; single-step mode; run artifacts |
| `src/llm/model-spec.ts`, `pi-clients.ts` | `provider/model` resolution; pi-ai solver and proposer clients with retries and expired-credential reload |
| `src/tools/python.ts`, `python/guard.py` | Guarded Python subprocess for solver-written code |
| `src/tools/bm25.ts` | In-memory BM25 index |
| `src/tasks/` | `toy:addition`, `rg:<family>` (Reasoning Gym bridge), `qa:hotpotqa|musique|2wiki` |
| `src/proposers/agentic.ts` | Agentic proposer: a pi coding-agent session with guarded read/edit/write, `check_harness`, `run_feedback` |
| `src/pi/extension.ts`, `service.ts` | pi package: `adapt_harness` tool, `/adapt` and `/harness-runs` commands |
| `src/learning/` | GRPO and SFT export, playbook distillation, structural audit |
| `src/cli.ts`, `src/config.ts` | `tta adapt / independent / eval / families / export / playbook`; paths and default models |
| `src/tbench/agent.ts` | Terminal-Bench session loop: probe, finish audit, reviewer, designer, truncation and filter recovery, fallback |
| `src/tbench/harness.ts` | Harness directory format and defaults |
| `src/tbench/remote.ts`, `bridge.ts`, `mcp.ts`, `selftest.ts` | Container bash tool and file operations, the JSON-lines bridge, MCP over SSE, tool-layer self-test |
| `src/tbench/report.ts`, `propose.ts`, `cli.ts` | Dev-only execution reports, the agentic harness proposer and its screens |
| `src/tbench/main.ts` | Entry point the Harbor agent spawns for each trial |
| `python/tbench/harbor_agent.py`, `harbor_patches.py` | Harbor agent and robustness patches |
| `python/tbench/aws_infra.py`, `remote.py`, `bootstrap.sh`, `imds_credentials.py` | Optional EC2 runner hosts |
| `experiments/` | Reasoning Gym, QA and calibration suites; `experiments/tbench/` benchmark tooling |
| `seeds/` | Seed harnesses: `rg-seed.js`, `tool-loop.js`, `qa-seed.js` (paper Fig. 12a) |
| `scripts/` | `install.sh`, `tbench.sh`, `check-model.ts` |
| `data/`, `runs/`, `jobs/` | Git-ignored: QA data, run artifacts, Harbor jobs |

## Conventions

- **Formatting.** Biome with tabs (indent width 3, line width 120). `npm run check` runs Biome, which rewrites
  files, and then TypeScript, so re-read a file after it.
- **TypeScript.** Node type stripping allows erasable syntax only: no enums and no parameter properties. Relative
  imports end in `.ts`.
- **Dependencies** are pinned exactly.
- **Test-driven.** Write the failing test, watch it fail, implement, then run `npm test`, `npm run check` and
  `npm run test:py`. Run them unpiped: piping a test command into `tail` inside an `&&` chain hides its failure.
- **Aggregates** are computed with scripts, never by hand.

## Testing approach

- **Model calls.** Unit tests use stub clients and pi-ai's `fauxProvider`, so they never call a model.
- **The agentic proposer and the Terminal-Bench agent** are tested against real pi tools. Their tests register the
  faux provider on a pi `ModelRuntime` with `registerNativeProvider`, so a scripted model drives pi's tools.
- **Container behavior.** Terminal-Bench tool-layer tests run bash locally and include merged output streams.
  `--ak self_test=true` checks the same behavior inside real task images.
- **Python** tests (`python/tests`) cover the Harbor agent's bridge, timeouts, model and environment handling, the
  Harbor patches, and the AWS tooling's policies and guards.

## Open items

1. **Terminal-Bench.**
   - Run the leaderboard protocol (online, all 66 tasks, 5 trials) with v6.
   - Reduce the reviewer's cost.
   - Look for changes that move the three tasks every version fails. Prompt rules have not.
2. **Distribution.**
   - Publish to npm, and test `pi install git:...`. That route needs `TTA_PYTHON`.
   - Make the runs root configurable, for example with `TTA_RUNS_DIR`. Otherwise runs are written inside the
     installed package.
3. **Statistical strength.** The paper averages 4 runs, and most results here come from one run per configuration.
4. **QA selection noise.** Possible fixes:
   - larger scoring sets;
   - re-scoring the top candidates on more questions;
   - keeping the best harness over all rounds.
5. **Paper items not done:**
   - GRPO or SFT training of a proposer (`tta export` produces the data);
   - the full-Wikipedia index;
   - format-varied Reasoning Gym questions.
6. **Small issues:**
   - `/adapt` accepts `--rounds 0` and treats an unknown protocol as `rg`.
   - `--temperature` with a non-number becomes NaN.
   - QA supporting-document tracking parses titles from truncated trace text.
   - GRPO export uses the first candidate's prompt, even when branch hints differ per candidate.

## References

- pi: <https://github.com/earendil-works/pi>. The exact APIs are in the type declarations under
  `node_modules/@earendil-works/`.
- Harbor and Terminal-Bench: <https://www.tbench.ai/>.
- Harness Learning: Zhang et al., *Harness Learning Enables Generalizable Test-Time Adaptation*, arXiv:2609.35738.
