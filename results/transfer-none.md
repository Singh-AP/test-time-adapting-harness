# Reasoning Gym multistep adaptation (transfer-none)

Solver qwen.qwen3-32b-v1:0, proposer qwen.qwen3-32b-v1:0. Proposer mode single. Protocol: 3 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|
| arc_1d | 0.15 | 0.15 | 0.15 | 0.15 | 0.00 | 0.01 | 0.17 |
| family_relationships | 0.65 | 0.65 | 0.65 | 0.65 | 0.00 | 0.00 | 0.01 |
| emoji_mystery | 0.01 | 0.01 | 0.01 | 0.01 | 0.00 | 0.01 | 0.11 |
| n_queens | 0.01 | 0.03 | 0.03 | 0.03 | 0.01 | 0.01 | 0.06 |
| polynomial_multiplication | 0.25 | 0.25 | 0.48 | 0.47 | 0.21 | 0.01 | 0.21 |
| propositional_logic | 0.35 | 0.35 | 0.35 | 0.35 | 0.00 | 0.01 | 0.05 |
| mahjong_puzzle | 0.42 | 0.42 | 0.42 | 0.27 | -0.16 | 0.01 | 0.23 |
| shortest_path | 0.22 | 0.33 | 0.33 | 0.33 | 0.11 | 0.01 | 0.16 |

Mean held-out: seed 0.259 -> final 0.282 over 8 families.
