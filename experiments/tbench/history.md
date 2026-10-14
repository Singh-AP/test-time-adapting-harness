# Harness history (development split only)

Shown to the proposer as HISTORY.md. It holds dev-split scores and change manifests only; held-out results stay in
results/ and never appear here. All runs are offline (no internet in task containers), with Sonnet 5.5 at max effort.

| Version | Parent | Dev result | Notes |
|---|---|---|---|
| v0 | - | 14/19 solved (partial run) | Prompt, environment probe, one finish check. Every failure stopped on its own well before the 8 h budget. |
| v1 | v0 | stopped early | v0 plus an independent reviewer and an all-or-nothing persistence prompt. A harness bug made the agent ignore most review findings, so the run was stopped and its numbers are not comparable. |
| v2 | v0 | pending | v0 plus engineering fixes: replies cut off by the output limit are continued (previously the agent silently stopped mid-task), compaction near 400k context, and a probe that reports cgroup CPU and memory limits. Prompts are unchanged from v0. |
| v2r | v1 | pending | v1 plus the same fixes. |
| v3 | v2 | pending | Proposer (Opus 5.5) from v0's dev report: a system-prompt section on how hidden tests are usually failed (treating "impossible" as the answer, ignoring provided information, unresolved judgment calls, testing only the visible example, leaving fixes in scratch areas, stopping early); a stricter finish audit; up to 2 finish checks. |
| v4 | v3 | pending | v3 plus the v2r independent reviewer (2 rounds), whose prompt gets a checklist of the same failure patterns (infeasible results, unused inputs, unresolved judgment calls, visible-example-only checks, scratch-area results, forbidden exposure). |
