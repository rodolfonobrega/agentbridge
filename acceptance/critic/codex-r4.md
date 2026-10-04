# codex r4 critic (in progress)

- Suite (fresh run): 18/19 pass, 1 FAIL: "timeoutMs kills grandchild processes" -> run returned without error (err.code undefined, took 55s < 60s timeout); test depends on model choosing to wait on the sleep. Flaky by design.
- Model check (listModels cache): rejects any bare slug not in ~/.codex/models_cache.json (cache lists only gpt-5.6-terra, gpt-5.6-luna, gpt-5.5 visible). Stale cache/new slug -> wrongly rejected before spawn, no override.
- Continue/fork ownership: test only asserts continue adopts "one of the two" concurrent sessions; OWN is process-global.
- Blind ref: ai-sdk-provider-codex-cli only SIGTERMs child (no tree kill), no model whitelist.

## Verified by execution (final)
- Kill tests x3 (+suite run): abort 4/4 pass; timeoutMs FAILS 3 of 4 (suite, run1, run3 fail; only run2 passes). Not deterministic; claim (1) false for timeoutMs.
- REAL BUG: hidden-but-valid model `codex-auto-review` is accepted by codex (returns "ok") but adapter throws BAD_OPTION "Unknown model" before spawn (listModels filters visibility hide). Same for any new bare slug before cache refresh. Codex itself already rejects unsupported models (gpt-5.4 -> 400), so the pre-spawn whitelist adds risk with little value.
- Continue no-id race test only asserts adoption of "either" concurrent session; OWN set is process-global.
- Not re-verified individually (covered by passing suite tests): tool id uniqueness, ephemeral, MCP approval, permissions/TEMP, jsonSchema.
- Blind ref (ai-sdk-provider-codex-cli): SIGTERM child only, no model whitelist, no ownership. Ours is ahead on tree-kill/abort, sandbox disclosure; loses on the model whitelist and timeout reliability.
Verdict: fixing.
