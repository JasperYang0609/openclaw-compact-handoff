# OpenClaw Compact Handoff

Compact Handoff is an OpenClaw hook pack that writes a session-scoped handoff file before context compaction and injects that same session's handoff on the next bootstrap.

It is designed for long-running GPT/Codex sessions where compaction can cause the agent to lose operational continuity.

## What It Does

- Writes an early handoff when a session reaches context pressure.
- Writes pre-compaction and post-compaction snapshots.
- Emits schema v2 metadata with a unique `generationId` for each handoff.
- Classifies transcript provenance and only treats trusted `real_user` messages as the latest user request.
- Excludes prior compact handoffs and bootstrap blocks instead of recursively embedding them.
- Injects only the matching `sessionKey` handoff at bootstrap.
- Avoids cross-channel/thread leakage by never reading a global latest handoff.
- Redacts obvious token, key, JWT, and long-secret patterns before storing recent transcript excerpts.
- Clips CJK and emoji text on UTF-16-safe boundaries.
- Enforces hard budgets: handoff body 8,000 characters, project recovery pointer 2,000 characters, and combined custom bootstrap 10,000 characters.
- Limits a single transcript evidence item to 1,200 characters and exact-reference lists to 20 items.
- Omits empty operator templates; absent evidence is not replaced with a blank checklist.
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

- `memory/session_handoffs/session_<sessionKey>.MEMORY.md`
- `memory/session_handoffs/session_<sessionKey>.state.json`
- `memory/session_handoffs/index.json`
- `memory/session_handoffs/*_early_*.md`
- `memory/session_handoffs/*_before_*.md`
- `memory/session_handoffs/*_after_*.md`

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
- low-pressure skip
- redaction
- health index creation

`recentTurnsPreserve: 3` is not a required hook setting. It is only a conditional, separately approved mitigation when an isolated replay proves that the current native compaction suffix still exceeds its budget; do not change it merely to install this hook.

## Post-Run Self-Check

After changing or reinstalling the hook, run:

```bash
npm run postrun:check
```

The check verifies the hook registration, session-scoped handoff behavior, removal of the old global handoff fallback, redaction coverage, and the deterministic hook test. Treat a failed check as a failed release even if the gateway accepted the plugin.

## Safety Notes

This hook is deterministic and local-only. It does not call an LLM or external API inside the Gateway hook path.

It stores redacted recent transcript excerpts, but you should still avoid putting secrets into chat transcripts.
