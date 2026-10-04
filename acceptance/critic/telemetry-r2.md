# Critic telemetry r2
Own runs: telemetry 11/11, context 8/8 (opencode summarize-compact test 72s, not 209s: slow-variable, not flaky in my run), hooks 7/7, core 29 pass + 1 skip (SIGINT handler test, pre-existing skip). Test files: node --check clean, no mangled escapes (template-literal `${statsUrl}` intact).
## r1 defect verification (own attacks: tmpcritic/race2.mjs, kill.mjs, attack2.mjs)
1. FIXED. 20 procs x 1 session: 20/20 runCount, 6 repeats (fresh and pre-existing 60s-stale lock, ~0.8s). kill -9 lock holder: 5 waiters all recover, runCount 5/5, but after a 14.4s stall (15s stale timer, no pid liveness check).
2. FIXED. compact() after=7764 exact (claude-session-file, via follow-up call) vs raw next-call usage 7781 (diff 17 = the extra prompt). Cost: compact makes a second model call.
3. FIXED. opencode contextOf 8805 == raw `opencode export` last assistant tokens 8805; model opencode-go/deepseek-v4.1-flash; handoff opencode->codex and summarize-compact pass with real facts.
4. FIXED. global has no pct; maxPct/maxPctSession; contextTokens == sum of parts.
5. FIXED. codex model gpt-5.6-luna and window 258400 from session file (windowSource session-file). Claude/opencode windows still table-based (widened on overflow).
## Remaining defects
1. Lock: finally-block unlinks the lock even if it was stolen after 15s (holder slower than 15s breaks mutual exclusion); kill -9 costs 15s stall. Low.
2. opencode reader is spawnSync `opencode export` (25s cap) inside contextOf: blocks the event loop, and stats() spawns one process per opencode session. Medium at scale; repro: stats() with many opencode sessions.
3. Test realism: compact test asserts only `after > 1000` and exact source, never compares to raw next-call usage; opencode tests use retry(2) which can mask flake and one test chains 5 model calls under a 290s cap (72s here, 209s reported by builder = little headroom). Low.
4. Still no rate-limit/quota tracking, no in-flight (live) context, no agent-side push.
## Blind comparison vs Orca (statusline-hook context %, 5h/7d limits)
Ours: exact per-agent context for 3 agents, honest exact/estimate labels, policy, compact, cross-agent handoff, hooks, cross-process safe. Orca: live context and rate limits for Claude only, no handoff/compact/policy. Verdict: ours. Biggest gap: quota/rate-limit and live mid-run context.
