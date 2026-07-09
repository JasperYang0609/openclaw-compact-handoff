# OpenClaw Compact Handoff

Compact Handoff is an OpenClaw hook pack that writes a session-scoped handoff file before context compaction and injects that same session's handoff on the next bootstrap.

It is designed for long-running GPT/Codex sessions where compaction can cause the agent to lose operational continuity.

## What It Does

- Writes an early handoff when a session reaches context pressure.
- Writes pre-compaction and post-compaction snapshots.
- Injects only the matching `sessionKey` handoff at bootstrap.
- Avoids cross-channel/thread leakage by never reading a global latest handoff.
- Redacts obvious token, key, JWT, and long-secret patterns before storing recent transcript excerpts.
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

- bootstrap injection
- cross-session isolation
- early threshold handoff
- low-pressure skip
- redaction
- health index creation

## Safety Notes

This hook is deterministic and local-only. It does not call an LLM or external API inside the Gateway hook path.

It stores redacted recent transcript excerpts, but you should still avoid putting secrets into chat transcripts.
