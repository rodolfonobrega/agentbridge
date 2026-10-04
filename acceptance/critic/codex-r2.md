# Critic: codex (round 2)
Verdict: OURS (blind pick: ai-sdk-provider-codex-cli exec-language-model.ts as strongest reference; ours has sessions/fork/ephemeral/tree-kill/validation it lacks; theirs maps cached_input_tokens, ours drops it).
Tests: 13/13 pass (codex-cli 0.155.1).

## Verified enforced (real runs, cwd "sp ace ü", concurrent)
- read-only: shell write in cwd denied. plan: no file written, plan text returned. edit: write to ~ denied, network blocked (curl code 000). unelevated sandbox actually enforces here.
- Sessions: fork unknown id/none -> BAD_OPTION, continue --help / none -> BAD_OPTION, invalid-uuid rejected.

## Bugs / weaknesses
1. Inconsistent error code: continue with well-formed unknown UUID -> AGENT_FAILED, fork same -> BAD_OPTION. Repro: session {mode:'continue',id:'00000000-0000-4000-8000-000000000000'}.
2. read-only/plan can READ anywhere on disk (read of file outside cwd returned contents); edit can write anywhere under %TEMP% (codex default writable root; a cwd in tmp makes sibling dirs writable). Not documented to callers; permissions read-only is not confidentiality.
3. windows.sandbox="unelevated" is injected silently (codex docs: weaker fallback than elevated, restricted token without dedicated sandbox users); adapter comment says "still enforces" but result carries no warning. Empirically enforced, but disclosure missing.
4. Usage drops cached_input_tokens and reasoning_output_tokens; no cost field. Tool events lack an id, so start/complete of the same command cannot be correlated (tool emitted twice, first w/o result). No thinking events observed (codex exec emits none) - unverified mapping.
5. Model validation by regexing codex stderr: fragile across codex versions (test only proves it today). PLAN mode is a prompt note + read-only sandbox (fine).
6. Timeout grandchild-kill: TIMEOUT thrown, taskkill /T used; my ping-grandchild probe was inconclusive (0 ping procs before/after) - unproven.

## Biggest gap
Usage/tool-event fidelity (cached/reasoning tokens missing, no tool ids) plus undisclosed weakened Windows sandbox and read-anywhere semantics.
