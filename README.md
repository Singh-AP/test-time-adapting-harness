# test-time-adapting-harness

An agent harness that adapts itself at test time, following *Harness Learning Enables Generalizable
Test-Time Adaptation* (Zhang et al., arXiv:2609.35738), built on the [pi](https://github.com/earendil-works/pi)
agent toolkit.

A *harness* is the program that organizes calls to a frozen solver model, tool use and information flow. A
*proposer* model reads the task description, the current harness and an execution report, and edits the
harness. Repeating this on development questions adapts the harness to a new task without changing any model
weights.

Status: under construction. See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for the
implementation plans.

## Setup

    npm install --ignore-scripts
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python reasoning-gym==0.1.19

## Test

    npm test
    npm run check
