# Security

## Threat model

agentbridge spawns coding agents that can read files, edit files and run commands **as you**. It adds guard rails but is not a sandbox:

- **Permissions** (`read-only`, `plan`, `edit`, `full`) are mapped to each CLI's own controls where they exist and enforced by agentbridge where they do not (`agy`, `pi`). `edit` is not strictly confined to the working directory for `agy` and `pi`; `pi` has no sandbox at all. Run untrusted work in a container or VM.
- **Agent-to-agent delegation** has a depth limit, a permission ceiling (a subagent never gets more than its caller) and HMAC-attested results. The attestation key is passed only through the process environment, never written to disk or argv.
- **Project trust:** project-local configuration (extensions, skills, hooks, `.pi/`) is not loaded for `pi`; `agy` runs in a private HOME so your global hooks and MCP servers are not inherited.
- **The proxy** binds to loopback by default and has optional bearer-token auth. Never expose it to other people: it turns your personal logins into a shared service, which providers' terms usually forbid.
- **Privacy & Telemetry:** agentbridge does not collect, track, or exfiltrate any remote telemetry, usage metrics, prompt text, or code. All metrics and run histories are strictly stored locally in `~/.agentbridge/telemetry/`. There are zero third-party telemetry services.
- agentbridge never reads, stores or transmits credentials; it relies on each CLI's own login or managed profile directories.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's "Report a vulnerability" (private security advisory) on this repository. Include the version, platform, a minimal reproduction and the impact. You will get an acknowledgement within a few days.

## Supported versions

Only the latest release on the default branch receives security fixes.
