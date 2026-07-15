---
name: compact-handoff
description: "Persist compact-safe handoffs before pressure/compaction and inject the matching session handoff at bootstrap."
metadata:
  { "openclaw": { "emoji": "🧭", "events": ["message:preprocessed", "session:compact:before", "session:compact:after", "agent:bootstrap"], "requires": { "bins": ["node"] }, "always": true } }
---

# Compact Handoff

Creates compact-safe handoff files under `memory/session_handoffs/` when a session reaches context pressure or compacts.

- `message:preprocessed`: if the persisted session is at high context pressure, saves an early handoff before compaction is required. Per-session serialization closes concurrent first-crossing races. A five-minute hard floor prevents per-turn writes. After the floor, soft-to-high can refresh; a 10K delta refresh is high-to-high only; and the normal twenty-minute interval never overrides high-to-soft suppression. A no-write soft observation is retained so a later rise to high remains detectable.
- `session:compact:before`: saves a pre-compact handoff with recent user/assistant turns and session metadata.
- `session:compact:after`: updates the handoff with post-compact stats.
- `agent:bootstrap`: injects only the matching `memory/session_handoffs/session_<sessionStorageId>.MEMORY.md` into bootstrap context when present. Unsafe or truncated session keys receive a deterministic SHA-256 suffix so two raw keys cannot share storage.

When `memory/project_states/registry.json` maps the current `sessionKey` to a project, the hook also adds a compact project recovery pointer. This pointer is deterministic and only reads:

- `memory/project_states/<project>/ACTIVE_TASK_STATE.json`
- `memory/project_states/<project>/PROJECT_GATES.json`

Unregistered sessions behave exactly like the baseline session-only handoff path.

The hook is intentionally deterministic and local-only: it does not call external APIs or another LLM from inside the gateway hook path. Archives, current handoffs, state, and index use temp-file + sync + atomic rename. Within one handler process, writes are serialized by session and index path; a current/index commit restores the previous current file when the index write fails, and an uncommitted archive is removed. Malformed JSON/shape indexes are preserved as `index.json.corrupt-*` before rebuild, while permission and other I/O read failures abort without quarantine. Because collision-resistant storage IDs cannot contain `@`, archive ownership accepts either an exact legacy storage ID or an exact reserved `@<uuid>` suffix grammar, never a delimiter prefix. Retention pins the archive referenced by the committed index, keeps at most five snapshots per exact session/phase, and removes other archives older than thirty days without targeting a prefix-neighbor or current/state/index file.
