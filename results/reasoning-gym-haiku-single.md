# Reasoning Gym multistep adaptation (rg-haiku-single)

Solver qwen.qwen3-32b-v1:0, proposer us.anthropic.claude-haiku-4-5-20251001-v1:0. Proposer mode single. Protocol: 5 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | R4 | R5 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|---|---|
| maze | 0.18 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.82 | 0.05 | 0.02 |
| count_primes | 0.04 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.96 | 0.03 | 0.03 |
| caesar_cipher | 0.00 | 0.96 | 0.96 | 0.96 | 0.96 | 0.96 | 0.96 | 0.03 | 0.06 |
| sudoku | 0.59 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.41 | 0.04 | 0.02 |
| group_anagrams | 0.63 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.37 | 0.04 | 0.03 |
| palindrome_partitioning | 0.01 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.99 | 0.04 | 0.06 |
| rotten_oranges | 0.08 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.92 | 0.04 | 0.09 |
| word_ladder | 0.06 | 0.06 | 0.06 | 0.12 | 0.14 | 0.17 | 0.10 | 0.23 | 1.32 |

Mean held-out: seed 0.199 -> final 0.891 over 8 families.
