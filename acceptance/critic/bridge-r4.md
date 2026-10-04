# bridge r4 critic (interim)

## Verified fixed (own attacks)
- D1 cross-process cancel under 3ms streaming: cancelled in 173ms; other-root cancel refused. FIXED.
- D5 messages: 4 procs x 50 sends + concurrent reader: 200/200 unique. FIXED (from still unauthenticated, labelled fromClaimed).
- D6 retry after error gets new run; after GC re-tracked. FIXED for sequential case (see N1 for a new race).
- D2 replay: one-time callId + promptSha + bind. Holds (unit).
- D4 stdout guard test passes; no hang.

## Defects
N1 (HIGH) D3 NOT fixed: key file is read+deleted LAZILY on first attestKey() call (first tool call), not at startup as comment claims. Repro: spawn mcp.mjs with mcpConfigFor(attestKey) env, idle 3s -> file still exists, readable, forged attestation verifies (true). Path is visible in mcp config/cmdline/env, and a shell-capable caller has the whole thinking+tool-planning time before its first ask. Severity: any edit/full caller forges proof. Also abk-* dir leaked if never consumed.
N2 (MED, flaky) idempotency race: dispatch() claims lock BEFORE save(rec); a second process sees lock with missing run, treats as GC-stale, retires lock, creates 2nd run. bridge.test 'idempotency atomic across processes' failed 2 of 5 runs (suite + 1 of 4 isolated).
N3 (MED, flaky) D7 not fixed: codex->codex pair failed in suite (callee sessionId null, callee text polluted by echoed attestation line); passed on isolated rerun. Codex chain test failed once in suite ("ask_codex tool is unavailable"), passed 2/2 isolated.
N4 (LOW) cancelRun on a live run that already finished flips in-memory state to cancelled and writes a stray .cancel marker while file says done.
N5 (LOW) no live message injection, no childPid unless adapter emits pid, from unauthenticated.

## Suites
bridge: 13 pass / 2 fail (idempotency race, codex chain flake). registry: 6/6 (D3 test checks shape only, does not test the file window). pairs: see below.
pairs: 14 pass/1 fail (codex->codex, passed 1/1 isolated => ~50% flaky). Other 8 pairs green. Verdict: theirs (Orca has SQLite-backed task/dispatch/gate DB, mutation-request retry identity, post-write settlement verification, live worker terminal delivery; ours file registry). Biggest gap: attest key forgeable (N1) + no live delivery.
