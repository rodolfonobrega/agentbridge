# Critic: core (round 3)
Verdict: THEIRS (blind vs cross-spawn/execa semantics; refs/ has no process runner). 23/23 tests pass, 1 skipped (signal test).
## Bugs
1. SECURITY, command injection via generic .cmd/.bat shim fallback (non-npm shim): with `echo.cmd` = `@echo off` / `node -e "..." %*`, `runCollect('echo.cmd',['x&calc'])` executes `calc` (stderr: "'calc\" \"y' is not recognized"). `q()` quotes for CreateProcess but the batch's own `%*` re-parse (BatchBadBut) is not escaped; cross-spawn double-escapes metacharacters for this reason.
2. Abandoned `lines` leaks child: `for await (const l of p.lines) break;` leaves the child running (verified alive after 300ms); generator has no return()/cleanup, output keeps buffering until maxBuffer.
3. Untyped TypeErrors: `spawnProc(cmd,args,null)` -> "Cannot read properties of null (reading 'timeoutMs')"; `{signal:{}}` -> "addEventListener is not a function" (should be BAD_OPTION).
4. Host side effects: hook() installs SIGINT/SIGTERM/SIGHUP/SIGBREAK handlers on first spawn, never removed. If the host registered its own handler, ours still SIGKILLs all children (host cannot drain them gracefully) and, being a listener, alters default SIGINT semantics. Also 16MB single-line hard-fails (40MB line -> AGENT_FAILED).
## Biggest gap
The .cmd fallback is injectable (arbitrary command execution from an argument), which a mature runner (cross-spawn) does not allow.
