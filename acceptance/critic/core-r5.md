# core critic round 5

Verdict: ours (blind vs cross-spawn/execa: they caret/quote-escape and still leak on .bat; ours rejects `"`, `%`, `!`, CR/LF/NUL for cmd fallback and spawns shim targets directly). Tests: 29 pass, 1 skip.

## Verified
- claude/codex/opencode resolve to .exe and are spawned directly; JSON with quotes, spaces, unicode reach argv intact. node/.js/parsed npm-style shims (spaces/()/& in dir) also intact for every payload (quotes, ^, %, !, &, |, <, >, newline, empty, trailing backslash, 9000 chars).
- Plain .bat via cmd fallback: `"&echo PWNED&"`, `%PATH%`, `!PATH!`, newline, `"` all rejected (BAD_OPTION); & | < > ^ ( ) , ; inert when the bat uses %1/%*.
- Iterator break kills tree incl. grandchild; 300k x 1KB lines in 0.8s; unconsumed flood -> AGENT_FAILED; no zombies.

## Bugs (none are injection holes in core itself)
1. Not core's fault but real: a plain .bat that uses `%~1` unquoted executes `&`: `tilde.bat` (`echo A1=[%~1]`) with arg `x&echo PWNED` runs echo PWNED; `a|b`, `a<b` break it. The quote-wrap is stripped by `%~1`. Inherent to cmd.exe; document, do not pass untrusted text to .bat.
2. Non-shim .cmd (e.g. real `npm.cmd`, `npx.cmd`) goes through cmd fallback, so `npm config get a"b` or any arg with `%`/`"` is BAD_OPTION. Legit but a functional gap for npm-style tools whose shim shape is not matched.
3. cmd fallback: args >~8191 total chars silently fail with exit 1 (no error). Non-ASCII args are mangled by the console codepage (`é✓漢` -> `?`), silent data corruption; trailing-backslash arg is doubled (`trail\` seen by the bat).

## Biggest gap
Non-shim .cmd/.bat (incl. npm.cmd) cannot take `"`/`%` args and silently corrupt unicode/very long args; should error on non-ASCII/over-length in cmd fallback.
