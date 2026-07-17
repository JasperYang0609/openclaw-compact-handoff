# Changelog

All notable changes to OpenClaw Compact Handoff are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [0.2.0] - 2026-07-17

### Added

- Provider-independent early handoff at 65% context pressure or 1.5 MB transcript size.
- Session-scoped pre/post compaction snapshots with bounded native-summary quality audit.
- One-attempt-per-generation bootstrap lifecycle with 24-hour expiry and explicit unconfirmed status.
- Cross-process filesystem locks, pending-current markers, rollback-aware current/index transactions, and bounded stale-recovery rules.
- Collision-resistant session storage IDs and exact-scope archive retention.
- Authoritative session/transcript binding with owner, path, symlink, device/inode, and post-read identity validation.
- Expanded structured/text/shell credential redaction and UTF-16-safe clipping.
- Bounded state/index/current/transcript reads, redacted quarantine metadata, and fail-closed I/O handling.
- Deterministic P1-C, resilience, authority, post-run, concurrency, redaction, and cleanup tests.
- LLM-oriented `AGENTS.md`, `llms.txt`, complete installation guide, rollback procedure, and cross-platform CI.

### Changed

- Final custom bootstrap content is bounded to 10,000 characters, with 8,000 characters reserved for the session handoff and 2,000 for an optional project recovery pointer.
- Empty operator templates and recursively embedded prior handoffs are excluded.
- Public documentation now states explicitly that this pack supplements rather than replaces OpenClaw native summarization.

### Security

- Handoff reads and writes fail closed on ambiguous ownership, unsafe paths, symlinks, malformed lifecycle state, unresolved transactions, and non-corruption I/O failures.
- Common authorization headers, cookies, private keys, JWTs, GitHub/Slack token forms, query secrets, and long-secret patterns are redacted before bounded evidence is persisted.

## [0.1.0] - 2026-07-16

### Added

- Initial public OpenClaw hook pack for compact-safe session handoffs.
- Basic early, before, after, and bootstrap lifecycle handling.
- Project recovery pointer support.

[0.2.0]: https://github.com/JasperYang0609/openclaw-compact-handoff/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JasperYang0609/openclaw-compact-handoff/tree/v0.1.0
