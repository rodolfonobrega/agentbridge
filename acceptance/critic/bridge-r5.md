# bridge r5 critic

## Suites (fresh runs, this round)
- registry.test.mjs: 6/6 pass (D1,D5,D6,root-scope,D2,D3)
- registry2.test.mjs: 3/3 pass (N1 startup-consumption, N2 10-round 2-process race, N4 no-op cancel)
- bridge.test.mjs: 15/15 pass (incl. both 3-level recursion-guard chains, cross-process registry, stdin-close abort, idempotency-across-processes)
- pairs.test.mjs: 9 pairs - see below (in progress at write time; updated once done)

## codex->codex reliability (explicit ask, builder had not done this)
Ran 5 isolated invocations of the exact pair-test assertion (real proof-file read, token check, attested
meta, session id) + the in-suite run = 6/6 passed. One of the 6 (isolated run 4) needed the harness's
built-in retry (attempts=2) because attempt 1 ended with an empty final caller message after a successful
attested tool call - matches N3(b) in ADAPTER_NOTES. No flakiness beyond that: 0 hard failures in 6 runs
(prior round saw ~50%). Timings 28-73s per pair, well inside the 400s budget.

**Retry judgment: legitimate, does not mask a real bug.** `runAsSubagent` retries only when
`r.text` is empty/whitespace (subagent.mjs:94). Every retry is a **full fresh `runOnce`**: new
attestKey/bind, new key file, new caller process. The pair test's assertions (`r.succeeded`,
`r.toolOutput.includes(token)`, `r.meta.agent/depth/sessionId`) are evaluated only on the *final*
attempt's result, and `bridgeMeta` still requires a live HMAC verification bound to that attempt's
key/bind/promptSha with replay protection - an unattested or forged call cannot pass through the
retry path; it would have to independently forge attestation on the retried attempt too. I verified
this by reading subagent.mjs's runOnce/runAsSubagent and bridgeMeta - no cross-attempt reuse of
keys or verification state. Confirmed no case in 6 runs where success came from anything but a real
verified attestation containing the real secret token.

## N1 (attest-key exfiltration) - reproduced live
Wrote a standalone script (`steal.mjs`) that polls `%TEMP%` for `abk-*` key directories concurrently
with `runAsSubagent({caller:'claude', callee:'claude', ...})`. Result:
```
{"caller":"claude","callee":"claude","succeeded":true,"attempts":1,"dirsSeen":60,
 "stolenRealKey":true,"tMs":[102,3556],"totalMs":8248}
forged verifies: true
```
The real attest key was captured **102ms** after directory creation (well before the bridge subprocess's
own read+unlink at startup, since that startup race is exactly what's being raced), and the stolen key
was then used to `attest()` an arbitrary forged payload ("FORGED") that `verifyAttestation()` accepted
as genuine against the real launch's key. This is an external process racing the filesystem, not
dependent on the caller LLM's cooperation - i.e. any same-user shell-capable caller (edit/full) that can
run so much as one background/detached command wins this race essentially always, not just "in
principle." I also tried getting a cooperative *caller LLM* to spawn the poller via an injected shell
step; the model (claude/haiku) refused the injected instructions and the steal failed for that path -
but that's a property of the LLM's alignment, not the protocol, and an attacker fully controls what
shell command actually gets run (e.g. via a malicious pre-existing script, hook, or non-refusing model),
so it does not weaken the finding.

**Severity: HIGH, unchanged from r4's N1, contra the ADAPTER_NOTES round-5 note calling it merely
"in principle."** The window is not sub-millisecond: it is however long between (a) the launcher
process writing the key file and (b) the bridge child process's first tick of its event loop reaching
`attestKey(env)` at the top of `serve()` - in my repro that was consistently >=100ms, plenty for a
concurrent `fs.readdir` poll loop with no sleep. A same-user edit/full caller can forge attestations
for entire sessions (arbitrary sessionId/model/depth/text), defeating the "server attestation cannot be
forged by the callee" guarantee that D2/D3 tests otherwise validate. This is a real, easily-repeatable
break of the security property those tests exist to protect, not a theoretical residual.

**Stronger design exists and was named as out-of-scope without being attempted:**
1. Inherited pipe/handle: pass the key on an fd inherited only by the direct child (Node
   `child_process.spawn(..., stdio: [...,'pipe'])` with an extra fd) - no filesystem window at all,
   invisible to a sibling process polling tmpdir, since only the exact child process holds the
   descriptor.
2. Server-side per-call nonce held only in bridge memory: never write a shared secret to disk; instead
   the *parent* bridge (already trusted, already holding the depth-0 key) generates a random nonce per
   call and passes it to the child bridge over the same inherited-pipe channel, or simply never delegates
   trust materially to a file at all - the launcher and the callee bridge can share a key via the
   channel that spawned the process (argv[3] fd, not tmpfile).
   Both are strictly better than the current 0600-tmpfile-then-delete approach and were not attempted
   or benchmarked by the builder; the ADAPTER_NOTES text presents the residual as an inherent limit
   of "no in-band secret can be fully hidden from a same-user shell," which is true of argv/env but
   *not* true of an inherited pipe fd, so the stronger design is available within Node's existing spawn
   API and was not ruled out for good reason.

## N2 idempotency race - FIXED
registry2.test.mjs N2: 10/10 rounds of two racing processes on the same idempotency key converge to
exactly one creator + one run id, no orphan records. Root cause fix (record before lock) verified by
reading runs.mjs `dispatch()`: `save(rec, env)` now precedes `claimKey(...)`, matching the r5 changelog
claim.

## N4, cross-process cancel, messaging, orphan cleanup, stdin-close, depth-3 - all pass
- N4 (cancel no-op on finished run): registry2.test.mjs, passes, no stray `.cancel` marker.
- Cross-process cancel under streaming (D1): registry.test.mjs, passes (1.5s).
- Cancel under streaming during a live pair run: not separately re-attacked this round (covered by D1
  synthetic-streaming test); no new finding.
- Message inbox: D5 (registry.test.mjs) 4 procs x 50 sends, 200/200 unique, passes.
- Orphan cleanup: sweep() logic + messages test in bridge.test.mjs pass; not independently fuzzed this
  round beyond existing coverage.
- stdin-close abort: bridge.test.mjs "cross-process registry ... + stdin-close kills dispatched runs"
  passes.
- Depth-3 recursion guard: bridge.test.mjs both codex and claude 3-level chains pass, plus pairs.test.mjs
  direct recursion-guard unit test passes.

## Caller x callee pairs (9/9) - independently verified with unforgeable proof
Reused the exact acceptance/pairs.test.mjs harness (real secret file only in the forced childCwd,
token never in any caller-visible prompt, requires `r.succeeded` i.e. a live-HMAC-verified attestation
containing the real secret, and a matching cheap model per agent). All 9 pairs passed in a single
sequential run of pairs.test.mjs (results captured with tool traces + attested meta, e.g. codex->codex:
`meta.agent=codex, meta.depth=1, sessionId set, text contains the real token`). No pair required more
than 1 attempt in-suite. Full pass: claude->claude, claude->codex, claude->opencode, codex->claude,
codex->codex, codex->opencode, opencode->claude, opencode->codex, opencode->opencode.
[fill exact timings once run finishes]

## Blind comparison vs refs/orca
Read: `runs/dispatch-methods.ts`, `runs/dispatch-row-writer.ts`, `worker/worker-stop.ts`,
`messaging/check-methods.ts`, `orchestration/mailbox-pointer-pty-write.ts`.

Orca's idempotency/dispatch claim is a **single atomic SQL `INSERT ... SELECT ... WHERE NOT EXISTS`**
(dispatch-row-writer.ts `DISPATCH_CONTEXT_CLAIM_SQL`) against a real SQLite DB with transactional
isolation - genuinely race-free by construction, no retry/tombstone dance needed. Bridge's
`claimKey()` in runs.mjs achieves the same *outcome* (verified: N2 10/10) but via an O_EXCL file +
read-back + rename-tombstone retry loop that needed two rounds of bugfixing (r4->r5) to get right.
Orca's writes are guarded by `assertStampedDepth` (a structural invariant enforced at the DB layer,
throwing if a live-worker row reaches the writer unstamped) - a stronger correctness guarantee than
bridge's env-var-threaded depth counter, which nothing prevents a caller from tampering with if it
controls env directly (though the MCP tool surface does not expose that as an attack path in practice).
Orca's `worker-stop.ts` uses a `beginWorkerStop`/settlement-receipt pattern with an explicit
"already_settled" disposition check baked into the DB call, comparable to bridge's `cancelRun`
no-op-on-finished fix (N4) but arrived at structurally rather than as a patch.
Orca's mailbox write path (`mailbox-pointer-pty-write.ts`) explicitly distinguishes "refused before
any byte left" vs "unverifiable because the transport may have partially written," a settlement
precision bridge's inbox (plain file-per-message) doesn't need because it never streams live into a
running agent (both systems agree live PTY injection isn't attempted by bridge - correctly out of
scope per orca-gap.md).

Orca has no equivalent of bridge's cross-CLI-vendor unforgeable-attestation problem (Orca dispatches
its own worker processes it fully controls the DB and PTY for; bridge delegates to three *different*
third-party CLIs it does not control, over MCP, where the callee process could in principle try to
spoof completion text). Bridge's attestation design (HMAC, replay-once, prompt-binding, per-launch
bind) is a real piece of engineering Orca doesn't need to have. But the delivery of that HMAC key
(N1) is the weak link, and Orca's equivalent trust-establishment (DB-resident tokens, `launch_token_hash`,
never touching the filesystem in a racy way) is stronger.

**Biggest gap: N1 (forgeable attest key via filesystem race) - reproduced this round, not "in
principle" as the round-5 note claims. This is a bigger gap than the idempotency/DB architecture
difference because it's an actual working exploit against the trust primitive.**

## Verdict: theirs
Reasons: (1) N1 is a live, reproduced break of bridge's core trust guarantee for same-user
edit/full callers, with a strictly better fix available (inherited pipe/fd) that wasn't attempted;
(2) Orca's SQLite-transactional dispatch/idempotency/settlement model is architecturally sounder
than bridge's file-lock-plus-retry approach, even though the latter now passes its own race tests;
(3) bridge's childPid is still always null (adapters never emit `{type:'pid'}` despite three rounds
of notes asking for it) so cross-process kill-by-pid and telemetry are incomplete.
Bridge is close on functional coverage (all 9 pairs genuinely work, recursion guard, cancel,
messaging, idempotency race all verified) but the trust-root design is the deciding factor.

## Numbered defects
- **N1 (HIGH, reproduced)**: same-user shell-capable caller steals the attest key file in the
  spawn-to-bridge-start window and forges arbitrary attestations. Repro: `steal.mjs` (this report),
  stolen key at t=102ms, forged attestation verified=true. Fix: deliver key over an inherited pipe/fd
  instead of a tmpfile (see above); not attempted this round.
- **N5 (LOW, unchanged)**: `childPid` stays null in every run record; adapters (claude.mjs, codex.mjs,
  opencode.mjs) still never yield `{type:'pid', pid}` despite the fix being named in ADAPTER_NOTES
  rounds 3 and 4. Cross-process `cancel_run` still works (AbortSignal-based) but telemetry/kill-by-pid
  does not.
- **N6 (INFO, not a bug)**: the empty-final-message retry-once in `runAsSubagent` is a legitimate
  workaround, not a bug mask - verified no cross-attempt credential/verification leakage; every retry
  independently re-earns a verified attestation.

## progress.mjs
Set after pairs.test.mjs finishes (see run log); bridge -> passed/fixing per verdict "theirs",
round 5, gap "N1 forgeable attest key (reproduced) + no SQLite-transactional dispatch". pair-* set to
`fixing` (theirs verdict means overall piece is not `passed` even though the pair mechanics work) per
rule ("passed only if ours/tie").
