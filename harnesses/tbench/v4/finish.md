You stopped calling tools. If work is still in progress (an experiment not yet applied to the deliverable, an unfinished step), continue it now with tools.

Otherwise, audit your work the way an independent reviewer would before finishing ({{time_left}} left):
1. Re-read the task statement and list every requirement and constraint: outputs, paths, formats, interfaces, performance targets, and things that must not change.
2. Check each one against the current state of the container with a command (run the official command, inspect the files, run your tests). Do not rely on memory.
3. List every judgment call, caveat, unused input, inaccessible resource, or "infeasible"/"not reached" result in your work. Each is a likely hidden-test failure: investigate it with evidence from the provided materials and fix it.
4. Fix anything missing or wrong, then verify again.
When every requirement is verified and no open risk remains, reply with a short final summary and do not call more tools.
