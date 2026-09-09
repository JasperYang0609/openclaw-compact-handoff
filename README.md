# OpenClaw Compact Handoff

[![CI](https://github.com/JasperYang0609/openclaw-compact-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/JasperYang0609/openclaw-compact-handoff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A provider-independent OpenClaw hook pack that protects session continuity before and after context compaction.

It works with any LLM connected through OpenClaw because it runs locally in the OpenClaw hook lifecycle and does not call a model or external API itself.

## What it is—and is not

**Compact Handoff adds a safety layer around OpenClaw's native compaction:**

- prepares a bounded handoff before context pressure becomes critical;
- saves session-scoped snapshots immediately before and after compaction;
- audits the persisted native compaction summary without copying it into logs;
- restores only the matching session's handoff at the next bootstrap;
- prevents cross-session leakage and redacts common credential formats;
- keeps local recovery metadata bounded and uses atomic, serialized writes.

It **does not replace OpenClaw's native summarizer** and it does not decide when native compaction runs. It improves continuity, recoverability, isolation, and auditability around that process.

## Stable install

OpenClaw `2026.6.11` routes direct `git:` sources through its extension-plugin installer, which rejects a hook-only package. Clone the pinned release first, then install that local path:

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git
openclaw plugins install ./openclaw-compact-handoff
openclaw hooks enable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
```

The final command must show:

```text
compact-handoff ✓ Ready
```

Then run:

```bash
openclaw hooks check
openclaw gateway health
```

For prerequisites, upgrades, rollback, troubleshooting, and a clean-room verification procedure, see [INSTALL.md](INSTALL.md).

## Give this to any AI assistant

Ask an OpenClaw-connected assistant:

> Install OpenClaw Compact Handoff v0.2.0 from https://github.com/JasperYang0609/openclaw-compact-handoff. Read and follow AGENTS.md exactly. Do not change my compaction settings without asking. Verify the hook is Ready and the Gateway is healthy; do not claim success from file copying alone.

Machine-oriented instructions are in:

- [AGENTS.md](AGENTS.md) — deterministic install/verify/rollback procedure for coding agents and LLMs;
- [llms.txt](llms.txt) — compact project and command summary;
- [INSTALL.md](INSTALL.md) — complete human-readable guide.

Maintainers should accumulate a reviewable change and run `npm run check:push` before pushing. Non-main branches use the focused Ubuntu Branch Check; pull requests and `main` retain the full Ubuntu/macOS CI matrix. Open PRs suppress duplicate branch tests, superseded runs are cancelled, and genuine failure notifications remain enabled.

## Compatibility

- **LLM/provider:** independent of provider and model; the hook does not call an LLM.
- **OpenClaw:** runtime-verified on OpenClaw `2026.6.11`; the required internal hook events were also statically present in `2026.7.1`.
- **Node.js:** Node 22 or a newer version supported by the installed OpenClaw release.
- **OS:** verified on macOS; CI runs the deterministic suite on macOS and Linux.

OpenClaw's internal hook API can change. After every OpenClaw upgrade, run the verification steps again before relying on the handoff.

## Trigger behavior

There are two separate trigger layers:

1. **Early handoff:** this pack writes a safety handoff when persisted context reaches 65% of the reported context window or the active transcript reaches 1.5 MB. This does not compact the session.
2. **Native compaction:** OpenClaw decides when to compact according to its active model, context budget, reserve settings, transcript size, provider behavior, and manual `/compact` requests. This pack listens to the before/after events; it does not override that decision.

Early snapshots are throttled per session. They use a five-minute hard floor and bounded refresh rules so a high-pressure session does not write on every message.

## Data handling

All operational state stays in the active OpenClaw workspace under:

```text
memory/session_handoffs/
```

The hook:

- performs no network requests;
- calls no LLM;
- never reads a global "latest" handoff;
- scopes every handoff to the authoritative OpenClaw session identity;
- redacts common authorization headers, cookies, private keys, JWTs, GitHub/Slack token forms, query secrets, and long-secret patterns;
- caps the rendered handoff at 8,000 characters and total custom bootstrap content at 10,000 characters;
- expires uninjected generations after 24 hours and bounds archive retention.

Redaction is defense in depth, not permission to paste secrets into chat. Avoid putting credentials in transcripts.

## Files written

The hook may create these local files:

```text
memory/session_handoffs/session_<sessionStorageId>.MEMORY.md
memory/session_handoffs/session_<sessionStorageId>.state.json
memory/session_handoffs/index.json
memory/session_handoffs/<timestamp>_<phase>_<sessionStorageId>@<uuid>.md
```

Temporary lock, pending, and bounded corrupt-quarantine artifacts can appear during atomic recovery paths. See [INSTALL.md](INSTALL.md) for operational details.

## Recommended OpenClaw settings

The hook works without changing compaction settings. Installation must not silently modify a customer's model, provider, context window, compaction thresholds, memory, channels, or schedules.

A separately approved safeguard configuration can improve the surrounding OpenClaw behavior, but it must be evaluated for the customer's active models. See [INSTALL.md](INSTALL.md#optional-compaction-settings) for the example used during validation.

## Test from source

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git
cd openclaw-compact-handoff
npm test
npm run postrun:check
npm pack --dry-run
```

The suite exercises session isolation, provenance filtering, one-shot lifecycle behavior, compaction-summary audit, concurrency, lock recovery, symlink/path defenses, bounded reads/writes, archive retention, Unicode boundaries, redaction, and temporary-tree cleanup.

## Safe rollback

To stop execution without deleting recovery files:

```bash
openclaw hooks disable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
```

The installed pack may remain on disk, but a disabled hook does not run. Do not manually edit OpenClaw's global bundled `dist` files. See [INSTALL.md](INSTALL.md#rollback-and-removal) before deleting package files or local handoff data.

## Release notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
