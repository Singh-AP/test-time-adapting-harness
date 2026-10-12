# Structure of adapted harnesses

Average calls per held-out question made by each run's final harness. Classes: algorithm-js / algorithm-python (fewer than 0.2 solver calls: the harness computes answers itself, in JavaScript or in Python the proposer wrote), interpreter (solver calls plus python: the solver writes code the harness runs), multi-call (more than 1.5 solver calls), single-call, retrieval (search calls).

| Task | Seed held-out | Final held-out | Solver calls | Python calls | Searches | Class |
|---|---|---|---|---|---|---|
| rg:caesar_cipher | 0.00 | 0.96 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:count_primes | 0.04 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:group_anagrams | 0.63 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:maze | 0.18 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:palindrome_partitioning | 0.01 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:rotten_oranges | 0.08 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:sudoku | 0.59 | 1.00 | 0.00 | 1.00 | 0.00 | algorithm-python |
| rg:word_ladder | 0.06 | 0.17 | 4.11 | 0.69 | 0.00 | interpreter |

Counts: algorithm-python 7, interpreter 1.
