# OpenClaw Compact Handoff

Compact Handoff is an OpenClaw hook pack that writes a session-scoped handoff file before context compaction and injects that same session's handoff on the next bootstrap.

It is designed for long-running GPT/Codex sessions where compaction can cause the agent to lose operational continuity.

## What It Does

- Writes an early handoff when a session reaches context pressure, with per-session serialization and a five-minute hard floor. Refreshes are directional: soft-to-high, high-to-high +10K, or a normal twenty-minute non-high-to-soft interval; high-to-soft and soft-to-soft +10K do not write.
- Writes pre-compaction and post-compaction snapshots.
- Emits schema v2 metadata with a unique `generationId` for each handoff.
- Classifies transcript provenance and only treats trusted `real_user` messages as the latest user request.
- Excludes prior compact handoffs and bootstrap blocks instead of recursively embedding them.
- Injects only the matching `sessionKey` handoff at bootstrap.
- Avoids cross-channel/thread leakage by never reading a global latest handoff.
- Redacts bearer credentials, GitHub/Slack tokens, unquoted or quoted Cookie/Set-Cookie headers (including shell-inline forms), quoted JSON credentials, secret query parameters, complete or unterminated private-key blocks, JWTs, keys, and long-secret patterns before storing recent transcript excerpts.
- Clips CJK and emoji text on UTF-16-safe boundaries.
- Enforces hard budgets: handoff body 8,000 characters, project recovery pointer 2,000 characters, and combined custom bootstrap 10,000 characters.
- Limits a single transcript evidence item to 1,200 characters and exact-reference lists to 20 items.
- Omits empty operator templates; absent evidence is not replaced with a blank checklist.
- Writes archives, current handoffs, state, and index files through temp-file + sync + atomic rename.
- Within one handler process, serializes each session transaction and each index path. If an index commit fails after a current write, it restores the prior current file.
- Preserves malformed JSON/shape indexes as `index.json.corrupt-*`; non-corruption read failures abort without quarantining or replacing the live index.
- Uses a readable, collision-resistant storage ID when a raw session key contains unsafe characters or must be truncated.
- Keeps at most five archives per collision-resistant session/phase and removes archives older than thirty days; current/state/index files are never retention targets.
- Maintains a lightweight `index.json` for health/debug visibility.

## Install

```bash
openclaw plugins install https://github.com/JasperYang0609/openclaw-compact-handoff.git
openclaw gateway restart
openclaw hooks info compact-handoff
```

If you prefer a local install:

```bash
git clone https://github.com/JasperYang0609/openclaw-compact-handoff.git
openclaw plugins install ./openclaw-compact-handoff
openclaw gateway restart
```

## Recommended Compaction Config

The hook works on its own, but it pairs best with OpenClaw's safeguard compaction settings:

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        keepRecentTokens: 50000,
        reserveTokensFloor: 30000,
        recentTurnsPreserve: 6,
        identifierPolicy: "strict",
        midTurnPrecheck: { enabled: true },
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 60000,
          forceFlushTranscriptBytes: "2mb"
        },
        postIndexSync: "await",
        truncateAfterCompaction: true,
        maxActiveTranscriptBytes: "20mb",
        notifyUser: true
      }
    }
  }
}
```

## Files Written

The hook writes local operational memory under your active workspace:

- `memory/session_handoffs/session_<sessionStorageId>.MEMORY.md`
- `memory/session_handoffs/session_<sessionStorageId>.state.json`
- `memory/session_handoffs/index.json`
- `memory/session_handoffs/<timestamp>_early_<sessionStorageId>@<uuid>.md`
- `memory/session_handoffs/<timestamp>_before_<sessionStorageId>@<uuid>.md`
- `memory/session_handoffs/<timestamp>_after_<sessionStorageId>@<uuid>.md`
- `memory/session_handoffs/index.json.corrupt-*` only when index recovery preserves a malformed prior index

`sessionStorageId` cannot contain `@`, so archive retention recognizes the complete reserved `@<uuid>` suffix rather than an ambiguous string prefix. This keeps safe and lossy IDs isolated from their neighbors, including legacy exact-name archives. A failed current/index commit removes its uncommitted archive; successful retention always protects the archive currently referenced by `index.json`.

## Test

```bash
npm test
```

The test covers:

- bootstrap injection and the 8K/2K/10K hard budgets
- cross-session isolation
- provenance-aware latest real user detection
- synthetic approval/memory-flush/runtime notice filtering
- non-recursive handoff generation
- schema v2 and unique generation IDs
- UTF-16-safe CJK/emoji clipping
- early threshold handoff
- five-minute hard-floor and twenty-minute refresh throttling
- low-pressure skip
- same-second unique archives, collision-resistant session ownership, and archive retention
- concurrent/lossless index updates, same-session current/index consistency, malformed-index recovery, and non-corruption I/O fail-closed behavior
- future-clock recovery and exact directional early-refresh throttling
- eleven-class secret-corpus redaction with non-secret operational references preserved
- health index creation, atomic-write temp cleanup, and successful-suite temporary-tree cleanup

`recentTurnsPreserve: 3` is not a required hook setting. It is only a conditional, separately approved mitigation when an isolated replay proves that the current native compaction suffix still exceeds its budget; do not change it merely to install this hook.

## Post-Run Self-Check

After changing or reinstalling the hook, run:

```bash
npm run postrun:check
```

The check verifies hook registration, session-scoped handoff behavior, hard budgets, atomic writes, serialized index recovery, archive retention, early-refresh throttling, expanded redaction, and both deterministic test suites. Treat a failed check as a failed release even if the gateway accepted the plugin.

## Safety Notes

This hook is deterministic and local-only. It does not call an LLM or external API inside the Gateway hook path.

It stores redacted recent transcript excerpts, but you should still avoid putting secrets into chat transcripts.
