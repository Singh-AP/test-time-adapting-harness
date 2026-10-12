# Reasoning Gym multistep adaptation (f2-haiku-single)

Solver qwen.qwen3-32b-v1:0, proposer us.anthropic.claude-haiku-4-5-20251001-v1:0. Proposer mode single. Protocol: 3 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|
| arc_1d | 0.16 | 0.16 | 0.23 | 0.23 | 0.07 | 0.12 | 0.25 |
| family_relationships | 0.68 | 0.68 | 0.68 | 0.81 | 0.13 | 0.14 | 0.01 |
| emoji_mystery | 0.01 | 1.00 | 1.00 | 1.00 | 0.99 | 0.03 | 0.07 |
| n_queens | 0.00 | 0.00 | 0.05 | 1.00 | 1.00 | 0.12 | 0.11 |
| polynomial_multiplication | 0.32 | 1.00 | 1.00 | 1.00 | 0.68 | 0.04 | 0.06 |
| propositional_logic | 0.27 | 0.31 | 0.31 | 0.31 | 0.04 | 0.10 | 0.07 |
| mahjong_puzzle | 0.36 | 0.76 | 0.76 | 0.76 | 0.40 | 0.12 | 0.19 |
| shortest_path | 0.17 | 1.00 | 1.00 | 1.00 | 0.83 | 0.05 | 0.04 |

Mean held-out: seed 0.246 -> final 0.764 over 8 families.
