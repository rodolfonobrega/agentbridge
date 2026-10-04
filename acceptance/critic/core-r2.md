# Critic: core (round 2)
Verdict: TIE (blind vs execa/cross-spawn semantics; refs/ has no process runner, no INDEX.md). 19/19 tests pass. All r1 bugs fixed: wait()-only 5MB stdout, split UTF-8, args quoting (space, quote, trailing backslash, %, &, CJK, empty), tree kill of grandchild on timeout, abort race, abort after exit, stderr flood (tail-capped), .cmd shim (npm), listener cleanup.
## Remaining bugs
1. Manual `p.kill()` returns exitCode 1 with no flag (not null, no killed/aborted/timedOut): `p=spawnProc(node,['-e','setInterval(()=>{},9)']); p.kill(); (await p.wait()).exitCode` gives 1 on Windows. execa exposes `isTerminated`/`killed`.
2. Non-array args gives an untyped `TypeError: args.map is not a function` instead of BAD_OPTION: `runCollect(node,'-e')`.
3. env values of `undefined` are stringified by node ("undefined"); execa drops them. Unhandled: `env:{A:undefined}`.
4. No parent-exit cleanup hook (execa `cleanup:true`): if the parent dies, children orphan.
## Biggest gap
Kill/exit semantics are not unified: user-initiated kill() is indistinguishable from a crash, and there is no orphan cleanup on parent exit.
