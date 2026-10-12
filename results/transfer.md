# Transfer of a distilled revision playbook (non-parametric outer loop)

The paper's outer loop trains the proposer on training tasks so that its revisions transfer to unseen tasks.
Here the proposer stays frozen; instead, a playbook of task-agnostic lessons is distilled (Opus 5.5, one call)
from 47 revision episodes on 8 training families (`results/playbook.md`, built from the Opus 5.5 and Haiku 4.5
runs in `results/reasoning-gym-multistep.md` and `results/reasoning-gym-haiku-single.md`), and shown to a weak
proposer on 8 families that contributed no episodes.

Setup: solver and proposer `qwen.qwen3-32b-v1:0` (the weak-proposer analog of the paper's base model), Reasoning
Gym protocol with 3 rounds, one proposal per round, kept only if the development score improves; 25
development and 75 held-out questions per family; same question seeds in both conditions. One run per
condition.

| Family | No playbook: seed -> final | With playbook: seed -> final |
|---|---|---|
| arc_1d | 0.15 -> 0.15 | 0.10 -> 0.17 |
| family_relationships | 0.65 -> 0.65 | 0.63 -> 0.63 |
| emoji_mystery | 0.01 -> 0.01 | 0.01 -> 0.01 |
| n_queens | 0.01 -> 0.03 | 0.00 -> 0.00 |
| polynomial_multiplication | 0.25 -> 0.47 | 0.25 -> 0.52 |
| propositional_logic | 0.35 -> 0.35 | 0.30 -> 0.08 |
| mahjong_puzzle | 0.42 -> 0.27 | 0.36 -> 0.36 |
| shortest_path | 0.22 -> 0.33 | 0.29 -> 1.00 |
| **mean** | **0.259 -> 0.282 (+0.023)** | **0.244 -> 0.345 (+0.101)** |

Reading: with the playbook the weak proposer's mean held-out gain is about four times larger, driven by
shortest_path (it followed the playbook's "compute exact answers in code, keep a model fallback" lesson) and
polynomial_multiplication. The playbook does not remove selection noise: on propositional_logic a revision that
raised the 25-question development score lowered held-out accuracy, and mahjong_puzzle regressed without it.
Seed scores differ slightly between the two conditions because the seed is re-evaluated with a sampling solver.

For scale, Haiku 4.5 as a single-shot proposer on the same families reaches 0.246 -> 0.764 in 3 rounds
(`results/f2-haiku-single.md`), with gains in later rounds (n_queens 0.00 -> 0.05 -> 1.00).

Files: `results/transfer-none.md`, `results/transfer-playbook.md`.
