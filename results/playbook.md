# Harness Revision Playbook

**What raised scores most**
- If the task has a well-defined algorithm, compute the answer in code instead of asking the model. Examples are search, counting, constraint solving, grouping, enumeration and cipher brute-force. One rewrite of this kind took several tasks from roughly 0.0–0.6 straight to 1.000 in a single round.
- JavaScript in the harness and a Python tool both worked. Pick whichever is simpler, and prefer direct JavaScript to avoid tool overhead.
- Parse the generator's fixed template with tight regexes. Also handle small variants, such as alternate blank markers or a trailing period on the payload.
- Keep a model fallback that runs only when parsing fails. It should never replace the exact path.
- When a brute-force space is small, enumerate every candidate and score each one. Example: try all 26 shifts and rank the results by English letter frequency.

**Output format is half the score**
- Match the reference's exact surface form: separators and spacing as `json.dumps` produces them, element ordering, bare numbers, and no trailing whitespace.
- Strip markdown residue such as backticks, bold and code fences. These alone caused partial-credit losses.
- Find out what the verifier tolerates, for example whether group order matters. Normalize anyway so the output is deterministic.
- Cover edge-case outputs explicitly, such as "impossible" giving -1 and "already done" giving 0.

**Reading the execution report**
- Sort failures into categories:
  - hallucinated or miscounted computation
  - wrong structure, such as bad grouping or missing items
  - formatting residue
  - parse failures
- Computation errors mean you should move the logic into code. Formatting errors mean you should post-process the output.
- Name the failing IDs that each change should fix. Then check after the run that those IDs were fixed.
- Confirm that the solver-call count dropped to zero where you expected the exact path to run.

**When the model must stay in the loop**
- Some tasks need open-ended knowledge, such as a dictionary of valid words. In these, model-generated vocabulary fed to an exact search gave no gain, because the model's word lists had gaps.
- A modest gain came from:
  - several sampled attempts in parallel, mixing temperature 0 with higher temperatures
  - pooling every candidate token from those outputs into a shared vocabulary
  - running a deterministic search or validation over that pool
- Expect only incremental gains on these tasks. Verify each step of a candidate in code before returning it.

**When to stop**
- At 1.000 with no failures, declare no_change. Extra heuristics add regression risk with no benefit.
- Before stopping, check that unseen questions will follow the same path: same template, input sizes within your guards, edge cases handled.

**Pitfalls**
- Don't let the model do arithmetic, counting or search that code can do exactly.
- Don't assume the model formats cleanly; sanitize its output.
- Infrastructure errors in the proposer, such as DNS or stream failures, produce invalid rounds. These say nothing about the harness, so retry rather than abandoning the approach.
- Don't over-engineer elaborate rewrites. A rejected rewrite cost a round with no gain.
- Add size guards to exponential enumerations, and keep the model fallback for inputs beyond them.
