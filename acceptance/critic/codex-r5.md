# codex r5
Suite 21/21 pass (fresh). Timer verified at 12s and 60s vs raw CLI: TIMEOUT by our timer, marker dead. Verdict: ours (tree-kill, sandbox disclosure, scoped sessions vs ai-sdk-provider-codex-cli). Minor defects: 1) orphan when codex ends turn itself (low, codex-caused); 2) BUSY/OWN are per-process only (cross-process id-less continue unprotected); 3) Windows reads unrestricted.
