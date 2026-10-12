# Reasoning Gym multistep adaptation (f2-haiku-agentic)

Solver qwen.qwen3-32b-v1:0, proposer us.anthropic.claude-haiku-4-5-20251001-v1:0. Proposer mode agentic. Protocol: 3 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|
| arc_1d | 0.14 | 0.14 | 0.20 | 0.20 | 0.06 | 0.75 | 1.12 |
| family_relationships | 0.68 | 0.56 | 0.84 | 0.75 | 0.07 | 0.57 | 0.02 |
| emoji_mystery | 0.01 | 1.00 | 1.00 | 1.00 | 0.99 | 0.05 | 0.08 |
| n_queens | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.10 | 0.04 |
| polynomial_multiplication | 0.33 | 1.00 | 1.00 | 1.00 | 0.67 | 0.05 | 0.05 |
| propositional_logic | 0.32 | 0.56 | 0.56 | 0.56 | 0.25 | 0.60 | 0.07 |
| mahjong_puzzle | 0.36 | 0.76 | 0.76 | 0.76 | 0.40 | 0.71 | 0.15 |
| shortest_path | 0.15 | 1.00 | 1.00 | 1.00 | 0.85 | 0.08 | 0.04 |

Mean held-out: seed 0.249 -> final 0.784 over 8 families.
