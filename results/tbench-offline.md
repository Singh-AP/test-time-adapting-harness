# Terminal-Bench 4.0, offline

## Setup

- Task containers have no internet (`experiments/tbench/offline.sh`, as under VPC Block Public Access).
- The task set is the 49 tasks whose reference solution passes offline: 46 CPU tasks and 3 GPU tasks. Of these, 24
  are dev and 25 held-out (`experiments/tbench/splits/tb4.json`).
- Agent: the pi harness (`src/tbench/`) with Sonnet 5.5 at max effort on Bedrock, one trial per task.
- Leaderboard numbers are not directly comparable: leaderboard runs have internet and cover all 66 tasks.

## Environment validation (oracle)

- Online: 59 of 63 CPU tasks pass and all 3 GPU tasks pass. The failures are `cad-model` (upstream PyPI drift)
  and `live-database-cutover` (flaky: 17/18 tests passed, then it passed on a rerun), plus 2 no-network tasks that
  failed on a Harbor probe race, since fixed.
- Offline: 46 of 63 CPU tasks pass, plus all 3 GPU tasks. The 16 lost tasks need the network in their reference
  solution or verifier: pip, apt or npm installs, model downloads or sidecar builds.

## v0 baseline (CPU tasks, offline, Sonnet 5.5)

| Subset | Tasks | Mean reward | Cost $ | Mean minutes |
|---|---|---|---|---|
| dev | 22 | 0.773 | 230.56 | 81 |
| heldout | 24 | 0.500 | 315.29 | 125 |
| all | 46 | 0.630 | 545.85 | 104 |

| Task | Split | Reward | Trials | Errors | Cost $ | Minutes | Turns | Stop | Reviews |
|---|---|---|---|---|---|---|---|---|---|
| atrx-vep-crispr | dev | 1.00 | 1 | 0 | 10.23 | 74 | 88 | completed |  |
| batched-eval-parity | dev | 1.00 | 1 | 0 | 11.28 | 65 | 112 | completed |  |
| biped-contact-dynamics | dev | 1.00 | 1 | 0 | 12.46 | 111 | 62 | completed |  |
| bun-sourcemap-leak | dev | 0.00 | 1 | 0 | 10.82 | 61 | 123 | completed |  |
| cargo-flight-dispatch | dev | 0.00 | 1 | 0 | 6.24 | 36 | 60 | completed |  |
| coq-block-bound | dev | 1.00 | 1 | 0 | 3.57 | 23 | 51 | completed |  |
| ctr-optimization | heldout | 0.00 | 1 | 0 | 21.13 | 295 | 219 | completed |  |
| data-anonymization | heldout | 0.00 | 1 | 0 | 10.68 | 94 | 124 | completed |  |
| distributed-dedup | heldout | 0.00 | 1 | 0 | 25.34 | 274 | 213 | completed |  |
| embedding-drift-monitor | dev | 1.00 | 1 | 0 | 10.84 | 78 | 116 | completed |  |
| formal-crypto | dev | 1.00 | 1 | 0 | 6.49 | 60 | 76 | completed |  |
| freecad-impeller | heldout | 0.00 | 1 | 0 | 21.40 | 239 | 144 | completed |  |
| freecad-platform-drawing | dev | 1.00 | 1 | 0 | 4.91 | 36 | 75 | completed |  |
| freecad-spring-clip | dev | 1.00 | 1 | 0 | 10.27 | 70 | 89 | completed |  |
| freight-dispatch-shift | dev | 0.00 | 1 | 0 | 13.31 | 91 | 111 | completed |  |
| glycan-ms2-elucidation | heldout | 0.00 | 1 | 0 | 11.85 | 93 | 82 | completed |  |
| heat-pump-warranty | heldout | 1.00 | 1 | 0 | 6.99 | 55 | 66 | completed |  |
| html-js-filter | heldout | 1.00 | 1 | 0 | 14.92 | 105 | 141 | completed |  |
| interleaved-vigenere | dev | 1.00 | 1 | 0 | 13.30 | 147 | 164 | completed |  |
| intrastat-meldung | dev | 1.00 | 1 | 0 | 8.09 | 56 | 88 | completed |  |
| ks-solver-cpp | heldout | 0.00 | 1 | 0 | 13.38 | 114 | 141 | completed |  |
| kv-live-surgery | heldout | 0.00 | 1 | 0 | 6.96 | 59 | 81 | completed |  |
| layout-config-recreation | heldout | 1.00 | 1 | 0 | 21.74 | 261 | 313 | completed |  |
| layout-config-recreation2 | heldout | 1.00 | 1 | 0 | 2.30 | 35 | 67 | completed |  |
| legacy-utility-triage | dev | 1.00 | 1 | 0 | 13.54 | 90 | 228 | completed |  |
| mp-checkpoint-consolidation | heldout | 1.00 | 1 | 0 | 6.96 | 69 | 97 | completed |  |
| mvcc-lsm-compaction | dev | 1.00 | 1 | 0 | 5.89 | 52 | 73 | completed |  |
| nextjs-performance | dev | 1.00 | 1 | 0 | 14.21 | 106 | 191 | completed |  |
| ontology-kg-querying | heldout | 0.00 | 1 | 0 | 17.48 | 125 | 182 | completed |  |
| photonic-waveguide-routing | heldout | 1.00 | 1 | 0 | 14.05 | 146 | 108 | completed |  |
| pretrain-shard-corruption | dev | 0.00 | 1 | 0 | 14.14 | 121 | 153 | completed |  |
| production-planning | heldout | 0.00 | 1 | 0 | 10.40 | 97 | 69 | completed |  |
| react-lead-form | dev | 1.00 | 1 | 0 | 10.61 | 68 | 111 | completed |  |
| retro-console-soc | dev | 1.00 | 1 | 0 | 19.60 | 167 | 166 | completed |  |
| risk-scorer-replay | heldout | 1.00 | 1 | 0 | 11.01 | 86 | 147 | completed |  |
| roy-polymorph-cn | dev | 0.00 | 1 | 0 | 2.48 | 21 | 21 | completed |  |
| rs-archive-clone | heldout | 0.00 | 1 | 0 | 8.33 | 65 | 126 | completed |  |
| session-window-debug | heldout | 1.00 | 1 | 0 | 3.27 | 26 | 23 | completed |  |
| sglang-qwen-burst | heldout | 1.00 | 1 | 0 | 30.55 | 174 | 421 | completed |  |
| shadow-relay | dev | 1.00 | 1 | 0 | 1.30 | 10 | 29 | completed |  |
| sound-change-cascade | heldout | 1.00 | 1 | 0 | 11.50 | 122 | 95 | completed |  |
| takens-embedding-lean | heldout | 1.00 | 1 | 0 | 14.59 | 103 | 153 | completed |  |
| uefi-bootkit | heldout | 0.00 | 1 | 0 | 2.65 | 27 | 56 | completed |  |
| vf2-speedup-networkx | dev | 1.00 | 1 | 0 | 26.99 | 243 | 206 | completed |  |
| wal-recovery-ordering | heldout | 0.00 | 1 | 0 | 9.38 | 88 | 91 | completed |  |
| wdm-design | heldout | 1.00 | 1 | 0 | 18.44 | 251 | 160 | completed |  |

## Harness improvement on the dev split (Sonnet 5.5, offline)

Versions (`harnesses/tbench/`, change notes in each `CHANGES.md`):

- **v0:** a prompt, an environment probe and one finish check.
- **v1:** an independent reviewer plus a persistence prompt. Stopped: a truncation bug hid its effect.
- **v2:** v0 plus the engineering fixes: replies cut off by the output limit are continued, compaction near 400k
  context, and a cgroup-aware probe.
- **v3:** a proposer (Opus 5.5) edit of v2 from v0's dev report: guidance on how hidden tests are usually failed.
- **v4:** v3 plus a reviewer with a targeted failure-pattern checklist.
- **v5:** a proposer edit of v3: tie-breakers for judgment calls.
- **v6:** v5 plus the v4 reviewer.
- **v7:** v6 plus an independent test designer that predicts the hidden tests (in progress).

Per-task mean reward on the non-trivial dev tasks (failed by at least one version). v3 to v6 have 2 or 3 trials per
task; the rest have 1:

| Task | v0 | v2 | v2r | v3 | v4 | v5 | v6 |
|---|---|---|---|---|---|---|---|
| bun-sourcemap-leak | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| cargo-flight-dispatch | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| freecad-platform-drawing | 1.00 | 0.00 | 0.00 | 1.00 | 0.50 | 0.00 | 1.00 |
| freight-dispatch-shift | 0.00 | 0.00 | - | 0.00 | 0.00 | - | - |
| intrastat-meldung | 1.00 | 1.00 | 0.00 | 0.67 | 1.00 | 1.00 | 1.00 |
| mvcc-lsm-compaction | 1.00 | 0.00 | 1.00 | 0.67 | 1.00 | 1.00 | 1.00 |
| pretrain-shard-corruption | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | - |
| roy-polymorph-cn | 0.00 | 0.00 | 1.00 | 0.33 | 1.00 | 1.00 | 1.00 |
Tasks finished in every run: 6

Notes:

- Most dev tasks are solved by every version. One-trial differences of one or two tasks are run-to-run noise, so
  candidates were compared with 2 trials on these tasks.
- Three tasks fail in every version: `bun-sourcemap-leak`, `cargo-flight-dispatch` and `freight-dispatch-shift`.
  Their transcripts show the model rationalizing against the guidance. They look capability-limited for Sonnet.
- The reviewer is worth its cost (about 40 to 50% more per trial) only with the targeted checklist (v4, v6). The
  generic reviewer (v2r) returned PASS on 16 of 18 trials, including failed ones.
