# core critic round 4

Verdict: tie (cross-spawn/execa have the same .bat quote-breakout class; ours adds a semantic-hijack bug). Tests: 28 pass, 1 skip.

## Bugs
1. SECURITY: arbitrary command injection through any plain .bat/.cmd (non node_modules/.bin, so single escaping).
   Repro: write q.bat = `@echo off` / `echo hi %1`; `runCollect('<abs>/q.bat', ['"&hostname&"'])` -> stdout contains the output of `hostname`.
   Cause: escArg backslash-escapes the quote (`\"`), but cmd.exe does not honour `\"`, so `"` toggles quote state and `&` is live. Quotes are the hole; the code rejects only %, CR, LF and NUL.
   Fix: reject `"` in .bat/.cmd args (or fully caret-escape everything outside quotes).
2. Shim hijack: resolveShim regex matches `%~dp0x.js` ANYWHERE in the .bat, including `rem` comments and secondary lines.
   Repro: multi.bat = `rem uses %~dp0helper.js maybe` / `echo REAL BAT %*`, with helper.js beside it -> runs helper.js and never runs the bat ("HELPER RAN"). Any .bat's real logic (set env, pre-steps) is silently skipped.
3. Minor: `%` in an arg is rejected even for the parsed-shim path, where it is harmless (behaves differently from cross-spawn); only the cmd fallback needs it.

## Fine
Iterator early-break kills the tree; signal handlers are conditional; validation fuzz clean; ordinary args (^ ! | & , ; unicode, trailing backslash) stay inert in the tested bat.

## Biggest gap
Quote handling in the cmd.exe fallback lets an attacker-controlled argument run commands.
