# Critic: core (round 1)
Verdict: THEIRS (execa/cross-spawn semantics; refs/ has no dedicated process runner). Blind, execa wins on robustness; ours wins only on tree-kill + .cmd shim parsing. 14/14 acceptance tests pass, but they miss the bugs below.

## Bugs (repro with spawnProc/runCollect from src/core/spawn.mjs)
1. HANG: `await spawnProc(node,['-e','process.stdout.write("x".repeat(5e6))']).wait()` never resolves. `lines` is a lazy generator, so stdout is never drained if the caller only calls wait(). The pipe fills and the child blocks. Any stdout over ~64KB deadlocks. The timeout also fires only if timeoutMs is set.
2. QUADRATIC line splitter: createLineSplitter does `buf += chunk; buf.split()` on every chunk. 20MB with no newline takes 71s. A 50MB single line through runCollect takes 6s. No maxBuffer or line-length cap, so a runaway child means an OOM/CPU DoS.
3. Bad cwd is misclassified: `runCollect(node,['-e','1'],{cwd:'C:/nonexistent'})` throws NOT_INSTALLED "spawn node.exe failed". The cause is ENOENT on cwd, not the binary. It should be BAD_OPTION.
4. spawnProc does not validate timeoutMs. `'abc'` is silently ignored; only index.validateOptions checks it.
5. Timeout/abort exit code is 1 on Windows (taskkill), not null, so exitCode is unreliable. Callers must use the timedOut/aborted flags.
6. stderr is a string capped by slice(-1e6) after concatenation, so it churns memory on a flood. Result: correct but wasteful. Only the tail is kept.
Held up OK: args quoting (spaces, quotes, trailing backslash, %, &, ^, CJK, empty), split UTF-8 across chunks, tree kill of a grandchild on timeout, pre-aborted signal.

## Biggest remaining gap
No backpressure/buffering contract: stdout is consumed only via lazy `lines`, so wait()-only usage deadlocks, and there is no maxBuffer or line cap. Fix: always drain stdout eagerly (into a bounded buffer or the line queue) and use a linear splitter (indexOf + array chunks).
