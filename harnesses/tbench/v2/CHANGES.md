# Changes from v0

Engineering fixes found while running v0 (dev split, offline):
- Replies were silently cut off by the output limit. The 400k effective context window clamped the output near the window, and compaction never triggered because pi estimated the context from a different source. Max effort also sometimes thought for all 128k output tokens. pi treats a reply without tool calls as the end of the turn, so the agent stopped mid-task. Now the window is the model's real 1M tokens, compaction triggers at about 400k (reserveTokens 600000), and up to 6 truncated replies are continued (compacting first when the context is large).
- The environment probe reports cgroup CPU and memory limits instead of the host's CPU count.
