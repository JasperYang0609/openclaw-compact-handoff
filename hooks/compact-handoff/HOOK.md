---
name: compact-handoff
description: "Persist compact-safe handoffs before pressure/compaction and inject the matching session handoff at bootstrap."
metadata:
  { "openclaw": { "emoji": "🧭", "events": ["message:preprocessed", "session:compact:before", "session:compact:after", "agent:bootstrap"], "requires": { "bins": ["node"] }, "always": true } }
---

# Compact Handoff

Creates compact-safe handoff files under `memory/session_handoffs/` when a session reaches context pressure or compacts.

- `message:preprocessed`: if the persisted session is at high context pressure, saves an early handoff before compaction is required.
- `session:compact:before`: saves a pre-compact handoff with recent user/assistant turns and session metadata.
- `session:compact:after`: updates the handoff with post-compact stats.
- `agent:bootstrap`: injects only the matching `memory/session_handoffs/session_<sessionKey>.MEMORY.md` into bootstrap context when present.

When `memory/project_states/registry.json` maps the current `sessionKey` to a project, the hook also adds a compact project recovery pointer. This pointer is deterministic and only reads:

- `memory/project_states/<project>/ACTIVE_TASK_STATE.json`
- `memory/project_states/<project>/PROJECT_GATES.json`

Unregistered sessions behave exactly like the baseline session-only handoff path.

The hook is intentionally deterministic and local-only: it does not call external APIs or another LLM from inside the gateway hook path. It also writes `index.json` and per-session state files so health/debug checks can see the latest handoff state without scanning every snapshot.
