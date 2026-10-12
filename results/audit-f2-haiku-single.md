# Structure of adapted harnesses

Average calls per held-out question made by each run's final harness. Classes: algorithm-js / algorithm-python (fewer than 0.2 solver calls: the harness computes answers itself, in JavaScript or in Python the proposer wrote), interpreter (solver calls plus python: the solver writes code the harness runs), multi-call (more than 1.5 solver calls), single-call, retrieval (search calls).

| Task | Seed held-out | Final held-out | Solver calls | Python calls | Searches | Class |
|---|---|---|---|---|---|---|
| rg:arc_1d | 0.16 | 0.23 | 1.05 | 0.00 | 0.00 | single-call |
| rg:emoji_mystery | 0.01 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:family_relationships | 0.68 | 0.81 | 1.00 | 1.00 | 0.00 | interpreter |
| rg:mahjong_puzzle | 0.36 | 0.76 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:n_queens | 0.00 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:polynomial_multiplication | 0.32 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:propositional_logic | 0.27 | 0.31 | 1.00 | 1.00 | 0.00 | interpreter |
| rg:shortest_path | 0.17 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |

Counts: single-call 1, algorithm-python 5, interpreter 2.
