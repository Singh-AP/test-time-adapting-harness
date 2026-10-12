# Reasoning Gym multistep adaptation (transfer-playbook)

Solver qwen.qwen3-32b-v1:0, proposer qwen.qwen3-32b-v1:0. Proposer mode single, with playbook. Protocol: 3 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|
| arc_1d | 0.10 | 0.10 | 0.17 | 0.17 | 0.07 | 0.01 | 0.24 |
| family_relationships | 0.63 | 0.63 | 0.63 | 0.63 | 0.00 | 0.00 | 0.01 |
| emoji_mystery | 0.01 | 0.01 | 0.01 | 0.01 | 0.00 | 0.01 | 0.10 |
| n_queens | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.01 | 0.06 |
| polynomial_multiplication | 0.25 | 0.25 | 0.52 | 0.52 | 0.27 | 0.01 | 0.15 |
| propositional_logic | 0.30 | 0.08 | 0.08 | 0.08 | -0.23 | 0.01 | 0.10 |
| mahjong_puzzle | 0.36 | 0.36 | 0.36 | 0.36 | 0.00 | 0.01 | 0.21 |
| shortest_path | 0.29 | 1.00 | 1.00 | 1.00 | 0.71 | 0.00 | 0.04 |

Mean held-out: seed 0.244 -> final 0.345 over 8 families.
