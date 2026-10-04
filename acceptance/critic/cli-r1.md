# Critic Report: CLI (round 1)

Status: COMPLETE — verdict: ours

## Scope
- src/cli/{main,args}.mjs
- src/extras/{budget,schema,worktree,parallel,doctor}.mjs
- acceptance/{cli,extras}.test.mjs
- acceptance/run.mjs
- acceptance/RESULTS.md

## Plan
1. Run cli.test.mjs, extras.test.mjs, run.mjs in background, poll.
2. Direct CLI attacks (run/fanout/race/worktree/doctor/serve/json/budget/schema).
3. Exit codes, stdin piping, Windows path safety, defaults vs CONTRACT.md.
4. Blind compare vs refs/.
5. Verdict + defects.

## Findings so far

### Test suite (standalone)
- `node --test acceptance/cli.test.mjs`: 21/21 pass, 75.4s, no retries needed.
- `node --test acceptance/extras.test.mjs`: 15/15 pass, 46.2s, no retries needed.
- Matches acceptance/RESULTS.md (36/36 ALL GREEN).
- `acceptance/run.mjs cli extras`: run in background, taking much longer than the sum of standalone runs
  (still on "running cli.test.mjs" after several minutes) — likely because I was firing extra direct CLI
  probes concurrently against the same agent-CLI quota, not a bug in run.mjs itself. Re-verifying once idle.

### Retry-masking judgment (per instructions)
Two single-retry wrappers exist:
1. `cli.test.mjs` `abJsonRetry` around opencode session-continue test (retries whole CLI invocation with a
   fresh session on failure).
2. `extras.test.mjs` race test retries the whole `race()` call once if no winner.
Both retry the entire real-agent operation from scratch (not a narrower catch), and both attach a real symptom
(empty opencode turn / rate-limit blip) rather than swallowing a generic error. In my own run neither retry
fired (both suites passed on the first attempt). This is a reasonable amount of tolerance for real external
flakiness — not obviously masking a code bug — but it is unverified over multiple runs; a single clean run
does not prove the flakes are real and not race()-logic-triggered. Judgment: acceptable, flag as low confidence.

### Direct CLI attacks
- `ab doctor --no-models --json`: correct structured output, all 3 CLIs detected installed+logged-in.
- `ab serve --port 8799`: starts, `/v1/models` returns 200 with valid model list JSON.
- `ab bridge`: stdio MCP server responds correctly to `initialize` JSON-RPC.
- `ab run codex ... --worktree` on a **non-git cwd**: mode=copy, original dir untouched (only seed.txt
  remained), real diff returned with new file content. PASS.
- `ab race` real run (claude vs codex, "never stop counting" prompt): claude refused (safety) and won in ~5s,
  codex was aborted (`ABORTED`/cancelled). Process-list check via `tasklist` was inconclusive as a clean signal
  (many pre-existing claude.exe processes from other concurrent builders sharing the machine per task
  instructions), but code inspection of `src/core/spawn.mjs` `killTree()` (Windows: `taskkill /pid X /T /F`)
  plus the `race()` awaiting all promises before resolving supports the "loser truly killed" claim from the
  test. Not independently proven via handle inspection — residual risk noted as a gap, not a defect.
- `--json-schema 'not json'` -> USAGE, exit 2. Correct.
- `--permissions bogus` -> BAD_OPTION, exit 2. Correct.
- Unknown `--model` -> AGENT_FAILED, exit 1. Correct.
- `ab ask claude -` via real stdin pipe: works, prints only "PONG", exit 0.
- cwd with spaces and parens (`...\odd dir (test)\`): works correctly (Windows path/quoting safe).
- `--stream --json` output: 19-line NDJSON, every line valid JSON (verified programmatically). PASS.
- `askWithSchema` with a genuinely bad first response (plain-prose, no JSON): attempt 1 failed
  ("output is not valid JSON"), attempt 2 succeeded, `attempts=2`. Real retry-on-invalid confirmed, not just
  unit-tested.
- Default permissions confirmed read-only in src/index.mjs:45 (`if (o.permissions == null) o.permissions = 'read-only'`), matches CONTRACT.md.

### acceptance/run.mjs (the accept-suite runner itself)
Ran `node acceptance/run.mjs cli extras` standalone (after my own direct probing finished, to respect the
2-concurrent-real-agent budget). Result: both files PASS, 36/36, matches acceptance/RESULTS.md exactly
(cli.test.mjs 83.7s, extras.test.mjs 55.4s this run vs 92.4s/54.5s in RESULTS.md — normal variance). The
runner's own pass/fail line-scraping regex works correctly and RESULTS.md is regenerated faithfully.

### Budget abort — real process kill
Code-verified (not just via the passing test): `runBudgeted`'s AbortSignal is threaded into `coreRun` ->
adapter -> `spawnProc` (src/core/spawn.mjs), whose `onAbort` calls `killTree(child)`. On Windows that is
`taskkill /pid X /T /F` (kills the whole tree), plus a direct `child.kill('SIGKILL')` fallback. The
`--max-time` tests (both cli.test.mjs and extras.test.mjs) assert `r.aborted===true` and
`r.budget.exceeded==='time'` and complete well within the test's own generous timeout, consistent with the
child actually dying rather than the promise merely resolving early while a detached process lingers.

## Blind comparison vs refs/

Closest CLI/fanout/worktree reference per refs/INDEX.md: **orca** (stablyai/orca). It is architecturally a
different animal: a full Electron desktop app running Claude Code/Codex/OpenCode/Cursor CLI etc. in parallel
git worktrees, with the `orca` CLI (`src/cli/dispatch.ts`) acting only as a thin RPC client (`RuntimeClient`)
to the already-running app — the CLI itself contains no process-spawning, worktree, or race/fanout logic; that
lives in the Electron main process. It has much deeper Windows hardening in some areas (cmd shim resolution,
MSYS/Git-Bash job breakaway, EDR posture avoidance, process enumeration via a dedicated module rather than
shelling to powershell) documented in AGENTS.md, none of which agentbridge's worktree/spawn code addresses
explicitly (though agentbridge's own `resolveShim`/`cmdExe` in spawn.mjs independently solves the .cmd/.bat
injection problem orca also calls out).

agentbridge is a standalone, zero-dependency, zero-build Node CLI that itself performs every operation
(spawn, fanout, race, worktree, budget, schema) headlessly, matching CONTRACT.md's actual requirement ("Plain
Node ESM, zero build step... drive the installed CLIs"). Orca cannot be evaluated as "a CLI that does fanout/
worktree/race" standalone — it requires the full desktop app process running first, which is out of scope for
what this piece needs to be. vibe-kanban (Rust+TS, executor trait per agent, worktree-manager crate) is a
closer functional analog to agentbridge's `execOne`/worktree abstraction than orca is, but was not deep-read
this round.

**Verdict: ours.** agentbridge's CLI does more, standalone, with less surface area, and directly satisfies the
contract; orca is a different product shape (GUI-first) that isn't a fair drop-in substitute for this piece.

**Biggest remaining gap:** Windows edge-case hardening that orca calls out explicitly and agentbridge does not
handle/test: MSYS/Git-Bash job breakaway for child processes, and process-tree enumeration robustness beyond
`taskkill /T /F` (which can leave orphans if a child has already re-parented before the tree walk, a known
Windows taskkill limitation). Also: the worktree test suite already surfaces a real (if cosmetic) Windows gap
— `git apply`/`git add` in extras.test.mjs prints `warning: LF will be replaced by CRLF` — core.autocrlf is
explicitly disabled in the git config array (G) but the warning still fires from `core.safecrlf`/repo defaults
in the copy-mode git init; harmless today but worth silencing so real stderr diagnostics aren't lost in noise.

## Defects (numbered, with repro)

1. **(minor, cosmetic) worktree git noise not suppressed.** Repro: `node --test acceptance/extras.test.mjs`
   — "worktree: uses a real git worktree..." test prints `warning: in the working copy of 'a.txt', LF will be
   replaced by CRLF the next time Git touches it` to stderr even though `worktree.mjs`'s `G` array sets
   `core.autocrlf=false`/`core.safecrlf=false`. Root cause: those `-c` overrides are only passed to the `git`
   wrapper calls made through `git()`/`tryGit()` in worktree.mjs, but the test's own raw `execFileSync('git', ...)`
   setup commands (line ~84-87 of extras.test.mjs) don't pass them, so the *test-side* repo init is unaffected —
   not a library bug, but worth a comment so a future reader doesn't mistake it for one.
2. **(low-severity, unverified) race() loser-kill not independently confirmed via OS handle inspection.**
   `tasklist` around a real `ab race` invocation was inconclusive because other concurrent builders on this
   shared machine also run `claude.exe`/`codex.exe` (expected, per task instructions). Code path
   (`AbortController` -> `spawnProc` `onAbort` -> `killTree` -> `taskkill /T /F`) is sound by inspection and the
   test suite's `losers[0].cancelled===true` assertion is consistent with it, but a fully isolated
   process-handle proof (e.g. tracking the exact child PID before/after) was not obtained this round. Not
   blocking; flag for round 2 if a dedicated machine/window is available.
3. **(informational) retry-masking risk on 2 known flakes is low but not zero.** Both suite runs this round
   (standalone x2 and via run.mjs) passed 36/36 with zero retries triggered, so the flakiness could not be
   directly observed/characterized this round. The single-retry design (whole-operation retry, not a narrow
   catch) is reasonable, but nothing here proves the two flakes are truly external rather than an
   occasionally-triggered concurrency bug in race()/opencode session handling. Recommend the builder capture
   the raw failure text next time a retry actually fires, so this can be re-judged with evidence.

## Verdict

**ours** for cli, feat-parallel, feat-schema, feat-worktree, feat-budget, feat-doctor, and accept-suite. All
36 acceptance tests pass both standalone and via the suite runner, every direct CLI attack (doctor, serve,
bridge, worktree on git and non-git cwd, race, schema retry-on-genuinely-invalid-output, NDJSON validity,
exit codes, stdin piping, Windows path/quoting safety, default permissions) behaved correctly against real
agent CLIs. No blocking defects found; the 3 items above are minor/informational, not correctness bugs.

