# Agentic versus single-shot proposer

Proposer `us.anthropic.claude-haiku-4-5-20251001-v1:0`, solver `qwen.qwen3-32b-v1:0`, Reasoning Gym protocol with 3
rounds and one proposal per round (kept only if the development score improves), 25 development and 75 held-out
questions per family, same question seeds. Single-shot: one prompt with the report, SEARCH/REPLACE edits, up to 3
attempts. Agentic: a pi coding-agent session (SDK) in a scratch workspace with workspace-only read/edit/write,
`check_harness`, and up to 3 `run_feedback` evaluations on the feedback questions (paper App. F future work).

| Family | Single: seed -> R1 / R2 / R3 | Agentic: seed -> R1 / R2 / R3 |
|---|---|---|
| arc_1d | 0.16 -> 0.16 / 0.23 / 0.23 | 0.14 -> 0.14 / 0.20 / 0.20 |
| family_relationships | 0.68 -> 0.68 / 0.68 / 0.81 | 0.68 -> 0.56 / 0.84 / 0.75 |
| emoji_mystery | 0.01 -> 1.00 / 1.00 / 1.00 | 0.01 -> 1.00 / 1.00 / 1.00 |
| n_queens | 0.00 -> 0.00 / 0.05 / 1.00 | 0.00 -> 1.00 / 1.00 / 1.00 |
| polynomial_multiplication | 0.32 -> 1.00 / 1.00 / 1.00 | 0.33 -> 1.00 / 1.00 / 1.00 |
| propositional_logic | 0.27 -> 0.31 / 0.31 / 0.31 | 0.32 -> 0.56 / 0.56 / 0.56 |
| mahjong_puzzle | 0.36 -> 0.76 / 0.76 / 0.76 | 0.36 -> 0.76 / 0.76 / 0.76 |
| shortest_path | 0.17 -> 1.00 / 1.00 / 1.00 | 0.15 -> 1.00 / 1.00 / 1.00 |
| **mean** | **0.246 -> 0.614 / 0.629 / 0.764** | **0.249 -> 0.753 / 0.795 / 0.784** |
| proposer cost | $0.72 | $2.91 |

Reading: the agentic proposer adapts faster (mean held-out 0.753 versus 0.614 after round 1) and ends slightly
higher, because it can test a revision on the feedback questions before submitting it: n_queens is fixed in round 1
instead of round 3, and propositional_logic reaches 0.56 versus 0.31. It costs about 4 times as much in proposer
tokens, plus solver calls for `run_feedback`. Both
modes mostly converge to algorithmic harnesses written in Python (`results/audit-f2-haiku-*.md`). One run per
mode; family_relationships shows that development-score selection on 25 questions is noisy in both modes.

Files: `results/f2-haiku-single.md`, `results/f2-haiku-agentic.md`.
