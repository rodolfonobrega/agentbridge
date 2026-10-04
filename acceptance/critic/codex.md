# Critic: codex (round 1)
Verdict: OURS (narrowly) vs ai-sdk-provider-codex-cli exec-language-model.ts (blind: theirs has no fork/ephemeral/timeout, SIGTERM-only kill that does not tree-kill on Windows; sets approval_policy explicitly, ours doesn't). 11/11 acceptance pass, but real bugs remain -> fixing.

## Bugs (repro: adapter.run with cwd = fresh temp dir)
1. continue with unknown id silently starts a NEW session: session {mode:'continue',id:'not-a-uuid'} -> ok, new sessionId. Breaks contract (continue must append). Same for continue w/o id in a dir with no session (fresh session, no error).
2. Option injection: session {mode:'continue',id:'--help'} -> exit 0, empty text, sessionId:'--help' echoed back (result.sessionId falls back to o.session.id). Ids must be validated (uuid) -> BAD_OPTION; fork with id 'abc; rm' surfaces AGENT_FAILED "Session not found" instead of BAD_OPTION.
3. Permissions are recorded but NOT usable on this host: read-only cannot run ANY shell command (even reading secret.txt: "workspace sandbox blocked shell access"); edit/workspace-write cannot write (apply_patch file_change status failed x6, 76s burnt); default(read-only) cannot create files (correct) but also cannot read. Result exit 0, no error event, no warning -> caller thinks a normal answer. The test only asserts the sandbox_policy string in the rollout, so it never proves enforcement or function. Only 'full' works, which is the unsafe one.
4. AGENT_FAILED for bad model / bad extraArgs (should be BAD_OPTION when stderr says unexpected argument / model not supported). Minor.
5. jsonSchema not type:object -> raw AGENT_FAILED; no pre-validation. Minor.
Held up: effort max->xhigh, cwd (BAD_OPTION on missing), systemPrompt with quotes/newlines, mcp name validation, timeout/abort, fork noid empty dir -> BAD_OPTION, OPENAI_API_KEY stripped.

## Permissions decision
Sandbox failing with "deny-read ACLs" makes read-only/edit effectively broken on Windows here: enforcement is real (writes blocked) but so is total loss of function, silently. Better design: detect failed sandbox (tool 'failed' / "blocked" text / file_change failed) and emit a warning event + Result.warnings; probe once (cached) and if sandbox unusable, either throw BAD_OPTION for read-only/edit unless opts.allowUnsandboxed, or fall back to full sandbox-off + approval never + prompt-level constraint and say so loudly; and add a test that actually reads/writes.

## Biggest gap
Silent permission failure + unvalidated session ids (continue silently forks to new session; '--help' injected). 
