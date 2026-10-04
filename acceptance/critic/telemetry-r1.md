# Critic telemetry r1 (telemetry, context-policy, hooks)
Suites (own run): telemetry 7/7, context 7/7, hooks 7/7 pass.
Independent truth checks (tmpcritic/*.mjs): claude ctx 11013 == 2+6532+4451+28 of raw last usage; codex 15227 == raw last_token_usage; global == sum(sessions); exact labels honest for session-file sources.
Handoff claude->codex and codex->claude both recall the fact (non-degraded, seeded). Threshold compact fired at configured tokens. Codex summarize-compact 25060 -> 13658 (exact). Claude native compact 18419 -> true 9625.
Hooks: timeout/abort/consumer-break each fire start + exactly one terminal event; hang/50MB output/dead/non-loopback/userinfo-spoof URLs bounded (~2s), no leaked procs; prompt metachar injection inert (stdin JSON, no shell).
Corrupt/missing json tolerated. Reference: Orca uses agent-native statusline hooks (live context %, 5h/7d rate-limit); no handoff/compact/policy. OURS wins overall; gap = no rate-limit/quota + no agent-side push.
## Defects
1. Cross-process lost updates: 10 parallel processes finishing runs of one session -> session runCount 4/10 (foldIntoSession read-modify-write, no lock). Repro tmpcritic/race.mjs.
2. Claude native compact() returns after.tokens=484 (estimate=summary chars/4) vs true 9625 on next call (baseline system prompt ignored): 20x understatement; misleading for a "did it shrink" decision.
3. opencode untested (no session reader, compact/handoff paths unverified): medium severity, one of three agents.
4. global.pct sums windows across agents (458400 in denominator): not meaningful; "global context" is a sum of independent windows.
5. codex model reported as "default" (model name unknown), claude window from table (200k) not from file: window can be wrong for 1M variants until observed>window widening.
