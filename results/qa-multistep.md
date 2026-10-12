# Multi-hop QA adaptation (qa-v1)

Solver qwen.qwen3-32b-v1:0, proposer us.anthropic.claude-opus-5-5. QA protocol: best-of-G with G=4, 6 feedback and 32 disjoint scoring questions per round; held-out exact match after each round.

| Benchmark | Seed | R1 | R2 | R3 | R4 | R5 | R6 | Δ | Proposer $ | Solver $ |
|---|---|---|---|---|---|---|---|---|---|---|
| hotpotqa | 0.453 | 0.487 | 0.527 | 0.560 | 0.560 | 0.547 | 0.547 | 0.093 | 2.77 | 1.60 |
| musique | 0.273 | 0.307 | 0.307 | 0.420 | 0.380 | 0.420 | 0.260 | -0.013 | 2.91 | 2.84 |
| 2wiki | 0.500 | 0.620 | 0.633 | 0.640 | 0.680 | 0.653 | 0.653 | 0.153 | 2.36 | 1.26 |

Held-out exact match of each final harness on every benchmark (diagonal: in-domain):

| Harness | hotpotqa | musique | 2wiki |
|---|---|---|---|
| adapted on hotpotqa | 0.547 | 0.367 | 0.647 |
| adapted on musique | 0.307 | 0.260 | 0.373 |
| adapted on 2wiki | 0.500 | 0.307 | 0.653 |
