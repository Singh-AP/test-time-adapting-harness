# Reasoning Gym multistep adaptation (rg-v1)

Solver qwen.qwen3-32b-v1:0, proposer us.anthropic.claude-opus-5-5. Protocol: 5 rounds, one proposal per round, retained only if the development score improves; held-out scores after each round.

| Family | Seed | R1 | R2 | R3 | R4 | R5 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|---|---|
| maze | 0.18 | 0.99 | 0.99 | 0.99 | 0.99 | 0.99 | 0.82 | 0.25 | 0.02 |
| count_primes | 0.02 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.98 | 0.12 | 0.03 |
| caesar_cipher | 0.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.18 | 0.06 |
| sudoku | 0.60 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.40 | 0.22 | 0.02 |
| group_anagrams | 0.67 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.33 | 0.16 | 0.03 |
| palindrome_partitioning | 0.01 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.99 | 0.19 | 0.06 |
| rotten_oranges | 0.06 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.94 | 0.23 | 0.10 |
| word_ladder | 0.07 | 0.07 | 0.26 | 0.26 | 0.26 | 0.26 | 0.19 | 0.29 | 0.88 |

Mean held-out: seed 0.201 -> final 0.907 over 8 families.
