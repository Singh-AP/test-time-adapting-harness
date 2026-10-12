# Structure of adapted harnesses

Average calls per held-out question made by each run's final harness. Classes: algorithm-js / algorithm-python (fewer than 0.2 solver calls: the harness computes answers itself, in JavaScript or in Python the proposer wrote), interpreter (solver calls plus python: the solver writes code the harness runs), multi-call (more than 1.5 solver calls), single-call, retrieval (search calls).

| Task | Seed held-out | Final held-out | Solver calls | Python calls | Searches | Class |
|---|---|---|---|---|---|---|
| rg:caesar_cipher | 0.00 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:count_primes | 0.02 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:group_anagrams | 0.67 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:maze | 0.18 | 0.99 | 0.01 | 0.00 | 0.00 | algorithm-js |
| rg:palindrome_partitioning | 0.01 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:rotten_oranges | 0.06 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:sudoku | 0.60 | 1.00 | 0.00 | 0.00 | 0.00 | algorithm-js |
| rg:word_ladder | 0.07 | 0.26 | 10.00 | 0.00 | 0.00 | multi-call |

Counts: algorithm-js 7, multi-call 1.
