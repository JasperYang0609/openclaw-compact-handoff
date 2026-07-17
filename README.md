# OpenClaw Compact Handoff

Compact Handoff is an OpenClaw hook pack that writes a session-scoped handoff file before context compaction and injects that same session's handoff on the next bootstrap.

It is designed for long-running GPT/Codex sessions where compaction can cause the agent to lose operational continuity.

## What It Does

- Writes an early handoff when a session reaches context pressure, with per-session serialization and a five-minute hard floor. Refreshes are directional: soft-to-high, high-to-high +10K, or a normal twenty-minute non-high-to-soft interval; high-to-soft and soft-to-soft +10K do not write.
- Writes pre-compaction and post-compaction snapshots. Transcript ownership is resolved from the bounded authoritative agent `sessions.json`; every hierarchy component is owner-matching, non-group/world-writable, and non-symlinked. An event-provided session ID/path must exactly match the conventional regular-file pathname under that agent's sessions directory, so normalizing path aliases are rejected. Conventional validation is bound to the opened file's device/inode identity, and sessions-store/transcript handles are checked again after each bounded read so replacement, append, or truncation races fail closed. The store is still opened and safety-checked on every lookup, while an unchanged opened-file identity may reuse one of at most 16 parsed cache entries. The post-compaction path reads at most the newest 2 MiB of that JSONL, audits only the newest complete persisted `type:"compaction"` row, and records availability, length, required-section, latest-request, and exact-reference results without copying the native summary into the audit.
- Emits schema v2 metadata with a unique `generationId` for each handoff.
- Classifies transcript provenance, only treats trusted `real_user` messages as the latest user request, and only treats assistant-authored status text as deterministic completion/blocking evidence.
- Excludes prior compact handoffs and bootstrap blocks instead of recursively embedding them.
- Injects only the matching `sessionKey` handoff at bootstrap. OpenClaw 6.11/7.1 do not expose generation-correlated outbound delivery, so the conservative degraded lifecycle makes one bounded bootstrap attempt per `generationId`, stores `consumed:false` with `status:"injected-once-unconfirmed"`, and never claims delivery success. Lifecycle status and attempt count must agree (`injected-once-unconfirmed` = one attempt; `expired` = zero attempts); inconsistent state fails the current attempt closed. A new generation becomes eligible once; a generation older than 24 hours expires. Malformed lifecycle state fails the current attempt closed and is replaced with redacted quarantine metadata; the approved availability-first policy permits a separate clean retry, accepting the residual risk that corruption can cause the same generation to be offered again. The independent project recovery pointer is not suppressed when the session handoff is already attempted or expired.
- Avoids cross-channel/thread leakage by never reading a global latest handoff or accepting an event-provided transcript that disagrees with the authoritative session binding.
- Redacts all Authorization/Proxy-Authorization credential schemes, including quoted text keys, `:` or `=` assignment forms, repeated/mixed LF or CRLF folds after quoted or adjacent segments, shell-wrapped backslash/newline values, adjacent quoted/unquoted shell segments, and escaped unquoted shell words. If an LF/CRLF shell line-splice occurs at or after a decoded credential-header assignment, the bounded evidence item fails safe as a whole; this also covers residual-backslash quote parity. The splice scan is linear and constant-offset-state. Complementary near-2-MiB stress fixtures place all assignments before all splices and all splices strictly before all assignments, so both fail-safe outcomes exercise the real handler without a nested header-by-splice search. Dynamic shell expansions adjacent to a header, inside its enclosing quote, inside an adjacent quoted segment, or with `$(`/`${`/`<(`/`>(` introducers split across one or more shell line-splices also fail safe before nested shell quotes are interpreted. Complete JSON values are parsed before dispatch: decoded nested Authorization/Proxy-Authorization/Cookie/Set-Cookie keys in objects/arrays are replaced, non-sensitive fields within the 64-level traversal bound are retained, deeper subtrees fail safe, and recursively encoded JSON-string layers are decoded and scanned before valid compact JSON is serialized. Ordinary strings and terminal JSON-looking primitive strings retain their lexical content while using the text scanner. Quoted shell keys never qualify as structured fields by quoting alone. GitHub/Slack tokens, quoted JSON credentials, secret query parameters, complete or unterminated private-key blocks, JWTs, keys, and long-secret patterns are also redacted before storing recent transcript excerpts.
- Clips CJK and emoji text on UTF-16-safe boundaries.
- Enforces hard budgets: handoff body 8,000 characters, project recovery pointer 2,000 characters, and combined custom bootstrap 10,000 characters.
- Limits a single transcript evidence item to 1,200 characters and exact-reference lists to 20 items.
- Omits empty operator templates; absent evidence is not replaced with a blank checklist.
- Writes archives, current handoffs, state, and index files through temp-file + sync + atomic rename. Sensitive input files must be owner-matching, non-group/world-writable regular files; final symlinks fail closed.
- Combines process-local queues with owner-only exclusive filesystem locks for per-session and shared-index transactions, so independent handler instances using the same workspace cannot silently lose an index update or both claim one lifecycle generation. Lock waits are bounded. A stale artifact is recoverable only after bounded/no-follow metadata identifies an owner PID that no longer exists. A fixed owner-only recovery marker elects exactly one reaper and gates acquisition before and after lock creation; unknown or live owners are never stolen merely because the timestamp is old. If the elected reaper itself dies, its marker is preserved and later attempts fail closed until an operator verifies that no handler owns the recovery and removes the marker.
- Uses an owner-only, no-follow, exclusive pending-current marker while committing current/index. A pre-existing unresolved marker blocks later writes and bootstrap without being overwritten or cleared. If index commit fails, the previous current is restored; if that restoration also fails, the new archive and pending marker are retained and bootstrap fails closed instead of deleting the only recovery evidence. Cleanup is identity-guarded so one transaction cannot remove another marker.
- Reads lifecycle state through a strict allowlisted schema with a 32 KiB cap. Generation identities accept only UUID or `legacy-<32 hex>` forms, and persisted display timestamps accept only the hook's fixed numeric timestamp format. Malformed, oversized, inconsistent, or present-but-invalid lifecycle state is replaced by bounded redacted quarantine metadata and fails the current session-handoff attempt closed; under the explicitly approved availability-first policy, a separate clean attempt may recover. Corrupt state artifacts are limited to three regular files and seven days, including cleanup on routine successful state commits; pruning accepts only the hook's exact `timestamp-pid-UUID` quarantine suffix so a neighboring session's primary state is never a retention target. Non-regular artifacts are ignored safely. Permission and other I/O failures abort without quarantining or replacing live metadata. Exact preloaded session handoffs are removed before lifecycle directory, current, or state I/O; project recovery remains independent.
- Uses a readable, collision-resistant storage ID when a raw session key contains unsafe characters or must be truncated.
- Keeps at most five archives per collision-resistant session/phase and removes archives older than thirty days; current/state/index files are never retention targets.
- Maintains a lightweight `index.json` for health/debug visibility. Reads are capped at 512 KiB, no-follow, post-read identity checked, and schema-sanitized before mutation.
- Preserves the observed native-summary length in index audits up to the 2 MiB bounded-tail limit, including summaries rejected for exceeding the 16,000-character quality cap.

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
- `memory/session_handoffs/session_<sessionStorageId>.state.json.corrupt-*` only when lifecycle recovery writes bounded redacted quarantine metadata (maximum three regular files and seven days)
- transient `.compact-handoff.*.lock` files while a filesystem transaction is active
- transient `session_<sessionStorageId>.MEMORY.md.pending` while a current/index transaction is unresolved

`sessionStorageId` cannot contain `@`, so archive retention recognizes the complete reserved `@<uuid>` suffix rather than an ambiguous string prefix. This keeps safe and lossy IDs isolated from their neighbors, including legacy exact-name archives. A failed current/index commit removes its uncommitted archive only when current rollback succeeds; rollback failure retains the archive and pending marker for fail-closed recovery. Successful retention always protects the archive currently referenced by `index.json`.

## Test

```bash
npm test
```

The test covers:

- one-shot-per-generation bootstrap injection, 24-hour expiry, lifecycle state fail-closed behavior, concurrent bootstrap serialization, and the 8K/2K/10K hard budgets
- authoritative cross-session transcript isolation, including forged direct paths, symlinks, and invalid session IDs
- provenance-aware latest real user detection
- synthetic approval/memory-flush/runtime notice filtering
- non-recursive handoff generation
- schema v2 and unique generation IDs
- UTF-16-safe CJK/emoji clipping
- early threshold handoff
- five-minute hard-floor and twenty-minute refresh throttling
- low-pressure skip
- same-second unique archives, collision-resistant session ownership, and archive retention
- concurrent/lossless index updates across independent handler instances, same-session one-shot bootstrap locking, malformed-index recovery, pending-transaction behavior, and non-corruption I/O fail-closed behavior
- future-clock recovery and exact directional early-refresh throttling
- thirteen-value secret-corpus plus non-Bearer, quoted/assigned, folded, and shell-wrapped Authorization redaction and quoted/assigned Cookie redaction, with non-secret operational references preserved
- bounded 2 MiB transcript-tail reads and newest-compaction-only native summary auditing for the five required headings, 16K cap, latest request, and exact references
- bounded/no-follow current, lifecycle-state, and index reads; redacted corrupt-state retention; ancestor-chain authority validation; post-read identity checks; health index creation; atomic-write temp cleanup; and successful-suite temporary-tree cleanup

`recentTurnsPreserve: 3` is not a required hook setting. It is only a conditional, separately approved mitigation when an isolated replay proves that the current native compaction suffix still exceeds its budget; do not change it merely to install this hook.

## Post-Run Self-Check

After changing or reinstalling the hook, run:

```bash
npm run postrun:check
```

The check verifies hook registration, session-scoped handoff behavior, hard budgets, atomic writes, serialized index/session recovery, authoritative transcript ownership, bounded/no-follow state and handoff reads, one-shot injection lifecycle, bounded native-summary audit, archive retention, early-refresh throttling, expanded redaction, and all three deterministic test suites. Treat a failed check as a failed release even if the gateway accepted the plugin.

## Safety Notes

This hook is deterministic and local-only. It does not call an LLM or external API inside the Gateway hook path.

It stores redacted recent transcript excerpts, but you should still avoid putting secrets into chat transcripts.
