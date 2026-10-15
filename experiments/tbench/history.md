# Harness history (development split only)

Shown to the proposer as HISTORY.md. It holds dev-split scores and change manifests only; held-out results stay in
results/ and never appear here. All runs are offline (no internet in task containers), with Sonnet 5.5 at max effort.

| Version | Parent | Dev result | Notes |
|---|---|---|---|
| v0 | - | 17/22 solved | Prompt, environment probe, one finish check. Every failure stopped on its own well before the 8 h budget. |
| v1 | v0 | stopped early | v0 plus an independent reviewer and an all-or-nothing persistence prompt. A harness bug made the agent ignore most review findings, so the run was stopped and its numbers are not comparable. |
| v2 | v0 | 16/22 solved (same prompts as v0; the difference is within run-to-run noise) | v0 plus engineering fixes: replies cut off by the output limit are continued (previously the agent silently stopped mid-task), compaction near 400k context, and a probe that reports cgroup CPU and memory limits. Prompts are unchanged from v0. |
| v2r | v1 | about 13/18 solved (partial) | v1 plus the same fixes. |
| v3 | v2 | 3 trials on the hard dev tasks: still 0 on the three tasks every version fails; flaky tasks unchanged within noise | Proposer (Opus 5.5) from v0's dev report: a system-prompt section on how hidden tests are usually failed (treating "impossible" as the answer, ignoring provided information, unresolved judgment calls, testing only the visible example, leaving fixes in scratch areas, stopping early); a stricter finish audit; up to 2 finish checks. |
| v4 | v3 | hard dev tasks, 2 trials each: 0.58 on the common tasks | v3 plus the v2r independent reviewer (2 rounds), whose prompt gets a checklist of the same failure patterns (infeasible results, unused inputs, unresolved judgment calls, visible-example-only checks, scratch-area results, forbidden exposure). |

Observations across versions (dev only):
- Three tasks fail in every version and every trial. Prompt guidance about "infeasible" results, unused inputs and variant testing has not changed this: the agents read the guidance and still conclude as before.
- About five tasks flip between runs of the same harness, so differences of one or two tasks between versions are noise.
- The independent reviewer returns PASS on most failed runs and costs about 30% extra.
| v5 | v3 | hard dev tasks: 0.50 on the common tasks | Proposer from v3's dev trials: tie-breakers for judgment calls (prefer the reading under which the goal works out, the field's standard method, the general case, the strict reading of prohibitions); a near miss or tie means something is still wrong; "the original code did it this way" is not evidence; a summary that needs a limitations section means the work is not done. |
| v6 | v5 | hard dev tasks: 0.67 on the common tasks (best) | v5 plus the v4 reviewer with the targeted checklist. |
| v7 | v6 | hard dev tasks: 0.33 on the common tasks, rejected: the designer's predictions are sometimes wrong and the agent treats them as requirements | v6 plus an independent test designer that predicts the hidden tests before the agent starts; the predictions go into the first message and to the reviewer. |
