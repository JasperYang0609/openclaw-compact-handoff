# P1-C TDD Record — Injection Lifecycle and Native Summary Audit

Date: 2026-07-15
Base commit: `01685288e86859fb55f0a69b197567ed5f5dc4da`
Scope: P1-C only. No live hook install, gateway restart, config change, Node/OpenClaw upgrade, push, or PR.

## Compatibility decision

The audited OpenClaw 2026.6.11 and unpacked 2026.7.1 hook APIs expose `agent:bootstrap` mutation and persisted `type:"compaction"` JSONL rows, but no outbound event that correlates delivery success to a handoff `generationId`.

Therefore P1-C implements the approved conservative degradation:

- one bounded session-handoff injection attempt per generation;
- `consumed:false`, `status:"injected-once-unconfirmed"`, and `mode:"single-bootstrap-no-delivery-correlation"`;
- no claim that outbound delivery or model consumption succeeded;
- 24-hour generation TTL;
- project recovery injection remains independent;
- native summary audit reads persisted JSONL rather than trusting an unavailable hook-context summary field.

## RED 1 — lifecycle state absent

Test added to `scripts/test_compact_handoff_hook.mjs` requiring the first bootstrap to persist generation-scoped lifecycle state and a second fresh bootstrap to suppress the same session handoff.

Command:

```bash
npm run test:core
```

Observed exit: `1`

Observed failure:

```text
Error: bootstrap did not persist the degraded one-shot injection lifecycle
```

Evidence log: `/tmp/p1-c-injection-red1.log`

## GREEN 1 — one-shot generation lifecycle

Implementation:

- derives v2 identity from `generationId` and legacy identity from a SHA-256 content hash;
- writes lifecycle state atomically before mutating `bootstrapFiles`;
- suppresses an exhausted or expired exact session handoff while leaving project recovery independent;
- serializes lifecycle and early-refresh state operations through one per-session queue;
- preserves lifecycle fields during early-refresh state updates.

The core suite passed.

## RED 2 — lifecycle state I/O was not fail-closed

A fixture injected `EIO` while reading the exact session state file.

Command:

```bash
npm run test:core
```

Observed exit: `1`

Observed failure:

```text
Error: lifecycle state read I/O failure must fail closed instead of injecting
```

Evidence log: `/tmp/p1-c-injection-red2.log`

## GREEN 2 — strict state recovery and concurrency

Implementation and tests now cover:

- only `ENOENT` is treated as empty state;
- non-corruption state I/O errors abort injection;
- malformed JSON or invalid root shape is preserved as `session_*.state.json.corrupt-*` before recovery;
- state rename failure does not inject an untracked generation and a later retry succeeds;
- sixteen concurrent bootstraps inject one generation exactly once;
- a new generation becomes eligible exactly once;
- early refresh cannot erase lifecycle state;
- a generation older than 24 hours is removed from preloaded bootstrap files and recorded expired;
- legacy v1 content-hash generations are also one-shot.

Machine-readable core result includes:

```json
{
  "oneShotGeneration": "pass",
  "concurrentGenerationInjections": 1,
  "newGenerationReenabled": "pass",
  "expiredGeneration": "expired",
  "stateReadFailure": "fail-closed",
  "stateWriteFailureRetry": "pass",
  "malformedStateRecovery": "pass",
  "legacyContentHashGeneration": "pass"
}
```

## RED 3 — unbounded transcript read and no native audit

A >2 MiB JSONL fixture monkey-patched `fs.readFile(sessionFile)` to fail, requiring post-compaction processing to use a bounded file-handle tail read.

Command:

```bash
node scripts/test_compact_handoff_p1c.mjs
```

Observed exit: `1`

Observed failure:

```text
Error: post-compaction path attempted 1 unbounded transcript read(s)
```

Evidence log: `/tmp/p1-c-audit-red1.log`

## GREEN 3 — bounded persisted-summary audit

Implementation:

- uses `fs.open()`, `stat()`, and bounded positional reads;
- reads at most the newest `2 * 1024 * 1024` bytes;
- parses the first JSONL fragment when it is complete (including an exact 2 MiB boundary) and ignores it when the fragment is incomplete;
- uses the same bounded tail for recent-message recovery and native audit;
- searches backward for the newest complete `type:"compaction"` row only;
- never falls back to an older summary when the newest row has no usable string summary;
- validates the inclusive 16,000-character limit, structured `##` start, five required headings, latest real user request, and at least one exact reference when available;
- writes only `available`, optional `ok`, fixed reason codes, and `summaryLength` to the handoff/index;
- does not persist or log the native summary body in audit output;
- preserves the last native audit across later before/early index updates;
- reports bounded-tail I/O failure as `available:false` without claiming verification.

Machine-readable P1-C result:

```json
{
  "ok": true,
  "boundedTailBytes": 2097152,
  "boundedTailRequestedBytes": 2097152,
  "boundedTailOpenCount": 1,
  "boundedTailStart": 820,
  "expectedTailStart": 820,
  "goodSummaryLength": 356,
  "inclusiveMaxSummaryLength": 16000,
  "badReasonCount": 9,
  "newestCompactionOnly": true,
  "beforeAndEarlyAuditRetention": true,
  "persistedAuditSchemaAllowlisted": true,
  "unavailableTailRead": "session-tail-read-failed",
  "cleaned": true
}
```

## RED 4 — review found project coupling and preloaded bypass

The first independent Stage 1 specification review failed the frozen candidate. It found that lifecycle state read/write errors escaped before project recovery and left an exact preloaded session handoff in `bootstrapFiles` without a recorded attempt.

The read/write EIO fixtures were strengthened so each affected session is registered to `demo-project` and starts with an exact preloaded session handoff.

Command:

```bash
npm run test:core
```

Observed exit: `1`

Observed failure:

```text
Error: lifecycle state read I/O failure left a preloaded untracked session handoff
```

Evidence log: `/tmp/p1-c-review-red4.log`

## GREEN 4 — fail session closed, continue project recovery

Implementation now:

- removes every exact preloaded session handoff before lifecycle I/O;
- re-adds one bounded session handoff only after generation state commits;
- catches session-lifecycle errors inside `injectBootstrapUnlocked()` using fixed-code-only warnings;
- continues through independently budgeted project recovery after session read/write failures;
- verifies both state-read and state-write EIO paths remove the preloaded session handoff and still inject `PROJECT_RECOVERY.md`.

Machine-readable core evidence includes `stateReadFailureProjectRecovery:pass`, `stateWriteFailureProjectRecovery:pass`, and `preloadedFailureHandoffRemoval:pass`.

## Stage 1B coverage closure

The split Stage 1B review found no handler logic defect, but rejected the candidate for three missing characterization assertions. The P1-C suite now additionally proves:

- one session-file `fs.open()` and one positional `FileHandle.read()` are used for the shared recent-message/audit tail;
- the read starts at `max(0, size - 2097152)` and both requested and actual bytes are at most 2 MiB;
- both later `compact:before` and eligible `message:preprocessed` early updates preserve the prior `nativeSummaryAudit` object in `index.json`;
- serialized index content does not contain the secret-bearing summary body;
- persisted audit keys are limited to `available`, optional `ok`, `reasons`, and optional `summaryLength`;
- every persisted reason belongs to the fixed allowlist.

These were coverage gaps rather than observed production-code failures: the strengthened suite passed on its first execution. The new assertions are also required by `post_run_check.mjs` so they cannot be silently removed.

## RED 5–10 — Stage 2 security/reliability findings

The first Stage 2A reviewer timed out without a verdict. The independent Stage 2B reviewer rejected the frozen candidate for unsafe transcript ownership, unbounded/symlinkable bootstrap and lifecycle files, unbounded corrupt-state retention, and separate queues for session writes versus bootstrap lifecycle transitions.

New failing fixtures were added one behavior at a time:

| RED | Observed failure | Evidence log |
| --- | --- | --- |
| 5 | unknown secret-bearing state fields were copied back into persisted state | `/tmp/p1-c-security-red5.log` |
| 6 | lifecycle state used unbounded `fs.readFile()` rather than a bounded handle read | `/tmp/p1-c-security-red6.log` |
| 7 | oversized state remained in place and corrupt artifacts had no count/age/size bound | `/tmp/p1-c-security-red7.log` |
| 8 | bootstrap followed a symlinked current handoff and exposed arbitrary local content | `/tmp/p1-c-security-red8.log` |
| 9 | a same-session compact write completed while bootstrap held the lifecycle operation | `/tmp/p1-c-security-red9.log` |
| 10 | an event-provided victim `sessionFile` crossed into an attacker session handoff | `/tmp/p1-c-security-red10.log` |

## GREEN 5–10 — bounded files, one transaction queue, authoritative ownership

Implementation and regression coverage now provide:

- lifecycle state is reconstructed through a strict allowlisted and bounded schema on both read and write;
- state reads use one non-following regular-file handle with a 32 KiB cap;
- malformed/oversized state artifacts are pruned to at most three regular files, seven days, and 32 KiB each;
- current handoff reads are bounded to the UTF-8 worst-case body budget and use content/mtime from the same opened descriptor;
- current, state, sessions store, and transcript reads reject final symlinks and unsafe regular-file ownership/mode;
- one `sessionOperationQueues` transaction domain serializes same-session compact writes, early writes, bootstrap snapshot reads, and lifecycle state transitions;
- transcript ownership is resolved from the bounded authoritative `sessions.json` entry and conventional agent-session path;
- direct event `sessionId` and `sessionFile` must match that canonical binding; mismatches, unsafe path components, symlinks, and out-of-directory fallbacks are transcript-unavailable;
- tests use a temp-HOME authoritative sessions harness and include forged cross-session, canonical-symlink, and traversal-like session ID fixtures;
- exact state/current symlink failures remove untracked session preload while preserving independent project recovery;
- bounded normal legacy v1 handoffs retain one-shot content-hash behavior, while oversized legacy files fail closed.

The production store compatibility check (metadata only; no transcript contents read) observed a 2.95 MiB `0600` regular store, 135/135 safe session IDs, and 133 conventional transcript matches under the 8 MiB cap.

## RED/GREEN 11 — unchanged authoritative store cache

The strict resolver must open and validate `sessions.json` on every event, but reparsing the current 2.95 MiB store when its opened-file identity is unchanged would be an avoidable hot-path regression. A fixture disabled the cache hit and observed one store open plus one full store read, failing with `unchanged authoritative sessions store bypassed identity cache` (`/tmp/p1-c-cache-red11.log`).

The GREEN implementation caches only the parsed object and binds it to opened-handle `dev`, `ino`, `size`, `mtimeMs`, and `ctimeMs`. It still performs a no-follow open and safety stat on every lookup; an unchanged identity performs zero content reads, while atomic replacement or in-place metadata/content changes invalidate the entry. The cache is capped at 16 store paths.

## RED/GREEN 12 — known lifecycle string fields

Self-review found that dropping unknown state keys was insufficient: an attacker-controlled state file could place secret text in the known `injection.generationId` field and have an eligible early refresh serialize it again. The new fixture failed with `lifecycle state persisted a secret through the known generationId field` (`/tmp/p1-c-known-field-red12.log`).

The GREEN implementation accepts generation identities only as an RFC-style UUID or `legacy-<32 hex>` content identity. It also restricts `lastEarlyAt`, `injectedAt`, and `expiresAt` to the hook's fixed numeric timestamp grammar. A present-but-invalid injection record now fails closed and is replaced by redacted quarantine metadata rather than being silently dropped or copied into a routine state rewrite; the core suite passes.

## RED/GREEN 13 — cache identity invalidation

A second cache fixture atomically replaced the authoritative store while retaining the same path. With identity checks intentionally disabled it failed with `replaced authoritative sessions store reused a stale identity cache entry` and observed one opened store but zero content reads (`/tmp/p1-c-cache-invalidation-red13.log`).

The restored GREEN condition requires equality of `dev`, `ino`, `size`, `mtimeMs`, and `ctimeMs`; the replacement now triggers at least one bounded content read and refreshes the parsed entry. Machine-readable P1-C output records both zero reads for the unchanged hit and positive reads for replacement invalidation.

## RED/GREEN 14 — preload removal before lifecycle directory I/O

An exact-hash Stage 1A micro-review found that `injectBootstrapUnlocked` called `fs.mkdir` before removing an exact preloaded current handoff and outside its session fail-closed block. An `EACCES` directory fixture failed with `lifecycle mkdir failure left a preloaded untracked session handoff` (`/tmp/p1-c-review-red14-mkdir.log`).

The GREEN path computes the scoped current path and removes its exact preload before any lifecycle directory/current/state I/O. Directory creation now occurs inside the session-only catch, so project recovery is still built and injected independently.

## RED/GREEN 15 — corrupt state quarantine is not same-attempt recovery

The same review confirmed that malformed JSON/shape and oversized state were quarantined and converted to `{}`, allowing the same bootstrap attempt to inject as if no lifecycle existed. Updated fixtures failed with `malformed lifecycle state injected in the same attempt that quarantined state` (`/tmp/p1-c-review-red15-corrupt-state.log`).

The GREEN reader preserves and prunes the corrupt artifact, then raises fixed code `EINVALIDSTATE`. The current attempt remains fail-closed and project recovery remains available; a separate retry sees ENOENT and may inject the still-current generation once.

## RED/GREEN 16 — routine state-commit corrupt retention

A behavioral review found that max-three/seven-day/32-KiB corrupt retention was asserted only during corruption recovery, not a routine successful commit. A mutation disabled the routine prune call; the new fixture retained six artifacts and failed with `routine successful state commit did not enforce corrupt retention count` (`/tmp/p1-c-review-red16-routine-retention.log`). Restoring the prune call passes. Additional characterization fixtures cover state-read `EACCES`, current-read `EIO`, and current atomic-rename `EIO` while preserving the prior current/index and removing the uncommitted archive.

## RED/GREEN 17 — exact authoritative direct pathname

An implementation micro-review found that `path.resolve()` equality accepted a non-exact `/dir/./file` alias for the authoritative conventional pathname. The behavioral fixture copied its sentinel transcript into the handoff and failed with `non-exact alias path was accepted as authoritative transcript binding` (`/tmp/p1-c-review-red17-exact-path.log`). The GREEN resolver requires exact string equality before any direct-path metadata is accepted.

## RED/GREEN 18 — conventional validation bound to opened inode

The same review found a validation/open TOCTOU: the conventional path was lstat/realpath checked, then reopened without comparing the opened file to the validated inode. A deterministic atomic rename after conventional `realpath` but before tail open copied the replacement sentinel and failed with `authoritative transcript validation was not bound to the opened inode` (`/tmp/p1-c-review-red18-inode-binding.log`). The GREEN resolver carries device/inode identity from conventional validation, verifies direct metadata against it, and verifies the opened transcript handle (and early byte-size handle) again; the fixture now reports `ESTALE` and persists no replacement content.

## RED/GREEN 19 — Stage 1B behavioral coverage closure

An exact-hash behavioral review found seven implementation protections without direct fixtures: sessions-store size/no-follow/owner/mode, identifier matrices, observed `ESTALE`, complete compaction before a truncated row, real-user provenance ordering, per-lookup opened-handle stat, and max-16 cache eviction. Direct handler/filesystem fixtures now cover every category. They include a valid topic plus invalid agent/session/topic matrix; mode, mocked foreign owner, symlink flag, and 8-MiB pre-read rejection; explicit `ESTALE` warning capture; earlier-versus-latest and synthetic/tool/system provenance; and 17 distinct authoritative stores followed by an eviction reread.

Two mutations prove the key bounds are behavioral: raising the store cap from 8 to 9 MiB failed with `oversized sessions store was read before the 8 MiB bound rejected it` (`/tmp/p1-c-review-red19a-store-cap.log`), and raising cache capacity from 16 to 17 failed with `sessions-store cache did not evict beyond 16 entries` (`/tmp/p1-c-review-red19b-cache-cap.log`). Restoring both constants passes.

## Prior-candidate local gates (obsolete after final quality fixes)

Commands:

```bash
node --check hooks/compact-handoff/handler.ts
node --check scripts/test_session_authority.mjs
node --check scripts/test_compact_handoff_hook.mjs
node --check scripts/test_compact_handoff_resilience.mjs
node --check scripts/test_compact_handoff_p1c.mjs
node --check scripts/post_run_check.mjs
npm test
npm run postrun:check
git diff --check
npm pack --json
# unpack the generated tarball, then run npm test and postrun:check inside it
```

Observed:

- `npm test`: exit `0`; core, resilience, and P1-C suites pass.
- `npm run postrun:check`: exit `0`; 22 checks pass.
- actual package artifact after Stage 1A/1B fixes and behavioral coverage closure: 10 files / 50,543 bytes; required handler, all three test suites, and the authoritative test harness are included. After unpacking the `.tgz`, both `npm test` and `postrun:check` pass from the packaged tree.
- added-code scan: no `eval`, bare/child-process `exec`, `shell:true`, private-key literal, or GitHub-token literal.
- package remains local-only and deterministic.
- three complete post-coverage `npm test` + `postrun:check` replay rounds passed. Log SHA-256 values: `029df8142b98d311cc41391a37f7b55103bb0a8ae966f2f1c9fac5d57aefadc4`, `46ac71a115053a02e035150859ccb0d60b983e2f3410e5afe6ad74ac2dfba64e`, and `38b00dbe1dfa0153786668f0914060d596d292e74541c95de9ef4176f3b143e7`.

## Prior-candidate review gate

Candidates `e2a79a71ece462645c55e788849fe787c6089a81161263f444383a4434370d72` and `9154a7cccdffe5703fc10b9264ca101d135c4c4ed5d4b2852b8e32d420c3b1cc` failed micro-review and are obsolete. Fresh specification and quality/security reviews are still required against one unchanged replacement snapshot. P1-C is not deployable until both pass.

## RED/GREEN 20 — strict lifecycle corruption and redacted quarantine

The final quality review found that a parseable but invalid `injection` object could be silently dropped and that preserving the original malformed state bytes could retain secrets. Direct fixtures now require malformed JSON, invalid root/injection shape, and oversized state to fail the current attempt closed. The original artifact is removed from the active state path and replaced at the quarantine path by bounded metadata containing only schema, fixed reason, observed byte count, and (only when a bounded read succeeded) a SHA-256 digest. No original state body is retained. A directory using a corrupt-artifact name is ignored safely rather than passed to `unlink()`.

Evidence log: `/tmp/p1-c-quality-red20-lifecycle.log`.

### Approved availability-first lifecycle decision

The reviewer proposed a durable 24-hour tombstone that would prevent the same generation from being offered after corruption. Product authority explicitly selected the availability-first alternative: the corrupt bootstrap attempt fails closed, but a separate clean retry may offer the current generation once. This accepts a residual duplicate-offer risk if state corruption destroys the prior one-shot record, in exchange for not blocking the only recoverable handoff for up to 24 hours. Tests deliberately assert clean retry recovery; the hook still never claims confirmed model delivery or consumption.

## RED/GREEN 21 — bounded index and recoverable current/index rollback

Direct failure injection now covers bounded/no-follow index reads, unsafe/symlinked index rejection, schema sanitization, bounded prior-current reads, current rollback failure, retained recovery archive, and a persistent pending-current marker. A normal index failure restores the prior current and removes the uncommitted archive. If current restoration itself fails, the archive and marker remain, index stays at its prior generation, and bootstrap fails closed with `EPENDING`.

An additional direct fixture writes an index just over 512 KiB and instruments its opened handle. The expected GREEN result is zero content reads, unchanged oversized index bytes, no current file, and no archive delta. Mutating the cap from 512 to 513 KiB produces the expected RED (`/tmp/p1-c-final-mutation-index-cap.log`, SHA-256 `9a0d4ed994739ca79d0600427027731c86baeaa5f3b25f1eb1969c619846d236`).

Evidence log: `/tmp/p1-c-quality-red21-transaction.log`.

## RED/GREEN 22 — authority, post-read identity, redaction, provenance, and tail boundary

Fixtures now require all Authorization/Proxy-Authorization schemes to remove credential material; reject symlinked `.openclaw`, `agents`, or agent-ID ancestors; revalidate opened sessions-store/current/state/transcript identity and size after bounded reads; refuse mutations during reads; treat only assistant provenance as deterministic completion/blocking status; and preserve a complete compaction row that starts exactly at the 2 MiB tail boundary.

Evidence log: `/tmp/p1-c-quality-red22-authority.log`.

## RED/GREEN 23–24 — shared-filesystem transaction serialization

Two independently imported handler module instances (with separate process-local `Map` queues) were deterministically paused after reading the same shared index/lifecycle snapshots. Without a filesystem lock, one index entry was lost and the same generation was offered twice. Owner-only exclusive lockfiles with bounded wait, stale recovery, inode-aware cleanup, and separate per-session/shared-index lock names now preserve both index entries and exactly one lifecycle offer.

A second replay launches two real Node child processes against one temporary workspace. The first process pauses after its state read while the second contends on the session lock; after release, the second sees the committed one-shot record. The machine-readable result requires `crossProcessBootstrapInjections:1` and `sharedFilesystemLocks:"module-and-child-process-pass"`.

Stale recovery reads at most 4 KiB of owner-only, no-follow lock metadata and checks `kill(pid, 0)`. It reclaims only a lock whose real owner process has exited. A fixed owner-only `.recovery` marker elects one reaper across independent modules/processes; all acquirers check that marker before and after `O_EXCL` lock creation. Unknown or live owners time out rather than being stolen. If the reaper itself dies, the marker is preserved and future attempts fail closed with `ELOCKRECOVERY` pending verified manual removal. Fixtures use the PID of an actual exited child process and require `staleDeadOwnerLockRecovery:"pass"`, `concurrentStaleRecoveryExclusion:"pass"`, and `interruptedRecoveryMarker:"fail-closed-pass"`.

RED/GREEN 25 deterministically imports two real copies of the production lock helper and changes only scheduling at the stale-retirement boundary. Under the rejected `lstat`/pathname-`unlink` design, both reapers classify the old inode, the first acquires its successor lock, and the delayed second deletes that successor; the observed RED is `maxActiveProtectedTasks:2` (`/tmp/p1-c-red25-stale-reaper-race.log`, SHA-256 `80eef2628e5072b776669dadb0845cf9747db8c2413d983133ab59cfb8094484`). With the shared recovery claim, the same fixture is GREEN at one active protected task. Mutating the fixed marker to a per-instance random marker restores the same RED (`/tmp/p1-c-mutation25-random-recovery-marker.log`, SHA-256 `d2ec5e62d2fdac64b5005fa28a71513dafd42253298e54e174fa3951c2e912ff`).

Lock mutations are behavioral: bypassing every filesystem lock fails on lost shared-index updates (`/tmp/p1-c-final-mutation-filesystem-lock.log`, SHA-256 `2a4e846517c8454e777f7fd52ef49baa3635c4b8ecea52b592594dd7c418dc3b`); bypassing only session locks fails on duplicate one-shot injection (`/tmp/p1-c-final-mutation-session-lock.log`, SHA-256 `c74927ea26b72f295c0627fd284fa8434d3353c23095d0c2be638725752445a4`). The 8 MiB store and 16-entry cache mutations also remain RED, with SHA-256 `f2cd2813aae2c062a15baeeb69ed67b268fac77d80a2580f6c959114a3d5fd4b` and `f05bc0e8570eebc3318db4c945e96d6611046f13566e57ec37f958925a4e3d6f` respectively.

Evidence logs: `/tmp/p1-c-quality-red23-cross-instance.log` and `/tmp/p1-c-quality-red24-cross-instance-bootstrap.log`.

## RED/GREEN 26–30 — fresh specification and security review closure

The candidate frozen as `65f34b7569f82a09865dddc2e05f5d8aa4a77464602ce8cff99dc7c1617a7ba6` received a fresh filesystem-lock quality PASS, but specification and security reviews found five independent blockers. That candidate and all reviews tied to it were invalidated before any commit or deployment.

- RED 26 proves `status:"injected-once-unconfirmed"` with `attempts:0` cannot be treated as pristine state or injected in the same attempt. Status/attempt coherence now fails closed into quarantine, and a separate clean retry recovers. Original RED log SHA-256: `57ff3256a8fd6fa1fbc7625b12427673d26b37a569f78392c4a44aea6c1a04d3`; removing the invariant restores RED with `ceb7b2a6c0217d63638f8fc94dbd76992a4779982ade83fae72c416974018aaf`.
- RED 27 proves a pre-existing unresolved `.pending` marker must not be overwritten or cleared by a later current/index transaction. Marker creation is now owner-only, no-follow, exclusive, and cleanup is inode-identity guarded. Original RED log SHA-256: `647f51ed70f2812c03a670caeb3637946586ddd4493bcf1b1fdb0970b848639b`; removing `O_EXCL` restores the exact transaction/bootstrap failure with `bdaeceaa8513fa79f4e8d2283330df5d887aa0eb9d6ba16d3c3975d112d0ab6a`.
- RED 28 proves a rejected native summary longer than 16,000 characters must retain its actual audit length after a non-after index mutation. The sanitizer now accepts lengths through the existing 2 MiB bounded-tail limit. Original RED log SHA-256: `14e83923540e90606cdee879a0aeb60769eb15e29e49009af8ff5958407a67f7`; restoring the 16,000 sanitizer cap returns RED with `2658b8ee48f05e99125ee5f444c7c00bab529492e5873ef6059022afa44dfb05`.
- RED 29 covers quoted JSON and assignment forms for Authorization/Proxy-Authorization using Basic, Digest, and short opaque credentials. The redactor now recognizes quoted/unquoted keys and both `:` and `=` delimiters while respecting escaped value quotes. Original and matcher-regression mutation logs both have SHA-256 `38c4331f725a783e147d0e8c8f2ed313dcb1ba1d0fcb316c9301f3b49c9dce46`.
- RED 30 constructs a neighboring session whose primary lifecycle filename begins with another session's corrupt-artifact prefix. Retention now accepts only the exact generated `timestamp-pid-UUID` suffix grammar. Original RED log SHA-256: `f480c80c9843077d9095cfc2ab510fc4333dec95f44f65a813a55378f60dfece`; restoring prefix-only matching returns RED with `522fc5cc4e7d499517f9e0b96660da5a74f31a9c566fc1fd1be4043006f59324`.

## RED/GREEN 31–32 — continuation and structured Cookie review closure

The frozen `9362424ad1caef39da84ed36e1857a20847ba1b618ca785c817de7e92aae762c` candidate passed its focused specification review, but fresh quality and security reviews each found one HIGH credential-disclosure path. That candidate and every gate/review tied to it were invalidated before commit or deployment.

- RED 31 persists both `Authorization: Basic CRLF-space <credential>` and a shell-wrapped Authorization value containing `backslash + LF + <credential>`. The rejected first-line-only parser left the continuation credential in the handoff. Header values now scan to an unescaped closing quote across lines or consume every space/tab-prefixed folded continuation line. The deterministic RED and the first-line mutation both have SHA-256 `1f0329607beb63a41e2f06c4bd2ebbdf75b4c146c9e0ab5e433e331558fa2e0f`.
- RED 32 persists quoted JSON Cookie, quoted Set-Cookie, and quoted `=` assignment forms with three independent short credentials. Cookie/Set-Cookie now share the quoted-key, `:`/`=`, quoted-value, and continuation-safe header parser. The deterministic RED and the old unquoted-colon matcher mutation both have SHA-256 `df66e7c9adf6f779b9cf0318029027ba7b39da9363859625dee9f5016aa812f0`.

The frozen `baf643bef91b32eb5c58cbaf2b5dda0a882c52cd1c51d8c7cb81f77b5d61133f` candidate passed fresh specification and quality reviews, but its fresh security review found a HIGH shell lexical-adjacency bypass. That candidate and all gates/reviews tied to it were invalidated before commit or deployment.

- RED 33 persists four valid shell constructions: Authorization with a closing quote followed by backslash-LF plus an adjacent opaque segment, unquoted Authorization with escaped spaces and backslash-LF, Cookie with an immediately adjacent unquoted segment, and Set-Cookie with quote-plus-backslash-LF adjacency. The redactor now recognizes odd-backslash LF/CRLF continuation, shell escaped characters, adjacent quoted/unquoted word segments, and missing closing quotes; it conservatively redacts the complete bounded shell argument while preserving a consumed closing delimiter. Disabling both shell-adjacency branches restores the exact RED. The deterministic RED and mutation log both have SHA-256 `4c008040715a7e0de055709ba2c453821d6e6194f87f2c3792c68f8cf8a2dc6f`.

The frozen `1c799de44c36c7b0381be8dc58995b45266146deba8381820e8af75ac7bc515d` candidate passed fresh specification and quality reviews, but its fresh security review found a HIGH quoted-segment-plus-fold bypass. That candidate and every gate/review tied to it were invalidated before commit or deployment.

- RED 34 covers all four header families after a quoted close: Authorization with CRLF-tab fold, Proxy-Authorization with punctuation plus LF-space fold, Cookie with an even backslash run plus CRLF-tab fold, and Set-Cookie with repeated mixed CRLF/LF folds. A single continuation-aware state machine now evaluates each physical newline for either SP/HTAB folding or odd-backslash continuation and repeats until the logical header ends. Disabling the quoted continuation branch restores the exact RED. The deterministic RED and mutation log both have SHA-256 `1a8275ee3f0a738ef68e17c0b94dd04ab2489d8c6eb4e02400bb02eb878dee5a`.

The frozen `977775b70810ccb8858a3577ab07f3204cb2e4e54f9be33a968a6c5f0eea52f3` candidate passed fresh specification review, failed fresh quality review on a HIGH dynamic-shell command-substitution leak and MEDIUM structured-JSON delimiter loss, and received no security verdict because the provider filter blocked that review. The candidate and every tied gate/review were invalidated before commit or deployment.

- RED 35A persists compact JSON with an Authorization credential followed immediately by a non-secret `safePath`. Structural JSON serialization preserves valid delimiters and non-sensitive fields without weakening shell whole-header handling. Disabling this branch restores the exact safe-field-loss RED. The deterministic RED and mutation log both have SHA-256 `02466062a99c90e964e72e2d9a3e5f3f7a8d86420d9fb99da7ff210bee8ce7a9`.
- RED 35B covers Authorization and Cookie `$()` substitutions, Proxy-Authorization backticks, and Set-Cookie nested `${…:-$(…)}` with short opaque literals after command whitespace. On `$()`, `${}`, backticks, or process-substitution syntax in an adjacent shell word, privacy fails safe through the bounded evidence remainder instead of parsing nested shell grammar. Disabling this fail-safe restores the exact RED. The deterministic RED and mutation log both have SHA-256 `d72f621070c5166a9fa74d2cc41515f34075615fb9abdd1d5e3775b8c17f51a8`.

The frozen `08415b75f9b2027cac8773d061dead7167835a91b7d1c38f55263ab1fbd3208b` candidate failed fresh specification and quality review on the same HIGH quoted-key shell/structured-context intersection; the local privacy review timed out without a verdict. That candidate and every tied gate/review were invalidated before commit or deployment.

- RED 36 intersects quoted header keys/values with comma suffixes, `$()`, `<()`, and `>()` across all four header families, and separately retains safe fields for pretty JSON objects and compact JSON arrays. Complete JSON containers now use structural traversal; raw quoted shell text always uses the shell scanner. Forcing shell text through the former structured classification restores the exact RED. The deterministic RED and mutation log both have SHA-256 `882991d617b723cedc48e18874c2a192cbb0297174316bbc4c0288ef7231f1fc`.

The frozen `c4cfb0794f3defd3c9295408eecc2a166eec9c34bbe47bf427183f1c0c5aaa90` candidate failed fresh specification and quality review: parseability alone misclassified a shell header embedded in a JSON string, Unicode-escaped sensitive JSON keys were not decoded before matching, and nested pretty JSON could lose an outer safe field. The privacy review timed out without a verdict. That candidate and every tied gate/review were invalidated before commit or deployment.

- RED 37 combines a shell Cookie header inside a valid JSON `cmd` string, a `\u0041uthorization` key that decodes to Authorization, and nested pretty JSON containing all four credential-header keys plus outer safe paths. Valid JSON containers are now traversed by decoded key with a bounded depth fail-safe; credential-key values are replaced, ordinary strings run through the raw header scanner (including nested JSON strings), and the sanitized structure is serialized back to valid compact JSON. Disabling JSON-string scanning restores the exact RED. The deterministic RED and mutation log both have SHA-256 `0c4b5a8d6371ba54e09ec2a67e218818a91d63b24b9993262e21698e57255210`.

The frozen `58237eb723e20fe56bdd303815fb7415cd5fc52db1bb612101f0795b18927a8c` candidate passed exact source, artifact, privacy, replay, syntax, diff, and freeze gates, but a pre-review self-check found that a complete top-level JSON string containing serialized escaped-key JSON still bypassed the object/array-only root dispatcher. The candidate and every tied gate were invalidated before independent review, commit, or deployment.

- RED 38 wraps an escaped Authorization JSON object inside a complete top-level JSON string and retains its safe sibling. Root dispatch now parses every complete JSON value; strings are recursively checked for nested containers or scanned as text, while failed parse alone falls back to raw-text handling. Reverting root dispatch to object/array-only restores the exact RED. The deterministic RED and mutation log both have SHA-256 `fe2740df16b1f26c899f419b3e3a0b2fc9933867ebd69a0d86d1d68f46177a8c`.

The frozen `bc5aa2343a821b4b2a7690f2ef5d27a13765df113c9cb7a54797511590f8c25f` candidate passed exact source, artifact, privacy, replay, syntax, diff, and freeze gates plus fresh specification review. Fresh quality review timed out without a verdict; fresh privacy review found a HIGH leak when a dynamic shell expansion inside an enclosing header quote contained its own quoted arguments. That candidate and every tied gate/review were invalidated before commit or deployment.

- RED 39 covers `$()`, `${}`, backticks, `<()`, and `>()` inside enclosing quoted header values across Authorization, Proxy-Authorization, Cookie, and Set-Cookie. Every fixture contains nested double-quoted command arguments and a short sentinel after whitespace. The enclosing-value scanner now detects dynamic expansion syntax before interpreting any candidate closing quote, then fails safe through the bounded evidence remainder and emits one replacement closing quote. Removing that branch restores the exact RED. The deterministic RED and mutation log both have SHA-256 `1ad98744e516eb83d13235b29991e286798f9b78c0f652ed27c2ee3de05d67ac`.

Direct GREEN coverage now also proves the structural traversal boundary: a non-secret string leaf at depth 64 remains while its sibling Authorization value is redacted; a credential-bearing subtree beyond the bound becomes `[REDACTED_STRUCTURED_DEPTH]`, its deep safe field is intentionally discarded, and a safe field outside that subtree remains.

The frozen `3236dbcb3f4a3956646ccaf0c0dab1cd1d26082ff25cfdefba431d9bab677205` candidate passed all exact gates and was sent to fresh review, but a concurrent self-review found the adjacent quoted-segment form before those verdicts were accepted. Dynamic syntax inside the second segment could be skipped while `shellWordEnd()` was in quote state. That candidate, every tied gate, and every eventual review verdict were invalidated before commit or deployment.

- RED 40 covers the same five dynamic forms inside a quoted shell segment immediately adjacent to the first header segment, with nested quoted command arguments across all four header families. `shellWordEnd()` now checks for dynamic syntax before quote-state handling, so nested shell quotes cannot hide an expansion. Moving that check back below quote-state handling restores the exact RED. The deterministic RED and mutation log both have SHA-256 `ece3a57304fe07c2c87435e675c9a461029d88fa238438aa3e00c9457ff59f34`.

The eventual `3236dbcb...` privacy review also found a repeated JSON-string encoding leak that applies to the subsequent frozen `fb18df9e65c185aeef4d9379d4e35c081be26d08f6f98108a4accfafe3213719` candidate. An intermediate decode produced a string rather than an object/array, so the old container-only helper fell back to raw scanning while the decoded key remained escaped. `fb18df9e...`, its exact gates, and all reviews tied to older hashes are invalidated before commit or deployment.

- RED 41 triple-encodes a JSON object containing Authorization plus a safe sibling and verifies the innermost decoded shape independently. A tagged JSON parse result now distinguishes parse failure from every valid decoded value, and recursively decoded string/container layers reach the structural key sanitizer under the existing depth bound. Reinstating the object/array-only recursion restores the exact RED. The deterministic RED and mutation log both have SHA-256 `99ae293e76fe810fba188d1a33057e08b186abd2f97ab292246de2c91a208c32`.
- RED 42 proves that terminal JSON-looking primitive strings are not normalized while traversing safe fields: `1.2300` must remain lexically unchanged rather than becoming `1.23`. Terminal number/boolean/null decodes therefore use the raw text scanner, while decoded strings and containers recurse. Removing this terminal guard restores the exact RED. The deterministic RED and mutation log both have SHA-256 `f0a9bb8cf994e3b816873aafcba618bda79af70d53d227e0d8c56ef797e6e4e6`.

The frozen `93fddc84913132f610973024aa5777a792e74db7ac2667ec5a45506c3d36b003` candidate passed all exact gates and received fresh specification and quality PASS, but privacy review found that shell line-splicing could split a dynamic introducer before nested quotes. Those two PASS verdicts, every exact gate tied to that hash, and the candidate itself are invalidated; the privacy verdict remains finding evidence only. No commit or deployment occurred.

- RED 43 covers `$(`, `${`, `<(`, and `>(` introducers split across LF, CRLF, and consecutive mixed shell line-splices, with nested quoted arguments across all four credential-header families. `shellLineSplicesEnd()` now advances across each splice before `startsDynamicShellExpansion()` inspects the effective next character. Restoring direct adjacent-character lookup reproduces RED 43 even while RED 44's independent assignment guard remains enabled. The deterministic RED and mutation logs have SHA-256 `51fda812c1c9c2b05f2928ebb7d04a34007852d3dd40d48c874ec8a58cc38da5`.
- RED 44 extends the same shell-splice class to credential header names and the assignment delimiter. The scanner builds a bounded normalized view plus removed-splice offsets and fails safe only when a splice falls inside a decoded Authorization/Proxy-Authorization/Cookie/Set-Cookie assignment span. Disabling that guard reproduces RED 44 while RED 43 remains GREEN. The deterministic RED and mutation logs have SHA-256 `82c0143d18626e5fca2015f9093dc606af6fca8c6085c78638edfafa079a079e`.

The frozen `7e78465155b4b6142f48d8985812e78870b1e961cf6a25f9c960fbc04ebbe8ef` candidate passed all exact gates and received fresh specification PASS. Quality review found attacker-controlled quadratic offset matching before clipping, and privacy review found residual-backslash quote parity after line-splice removal. The candidate, specification PASS, and all tied gates are invalidated; both FAIL verdicts remain finding evidence only. No commit or deployment occurred.

- RED 45 covers LF/CRLF residual-backslash parity across all four credential-header families. After shell splice removal, the first apparent closing quote remains escaped and the following literal sentinel is still part of the header value. The policy now fails the bounded evidence item safe whenever any splice occurs at or after the first decoded credential-header assignment. Restoring the old assignment-span-only condition reproduces RED 45 while RED 43/44 and the linear source guard remain GREEN. RED log SHA-256: `b09d9025ab72983ff6179d25d4e54367dfc574f10b55a98763ddec2e027d3af3`; mutation log SHA-256: `6ce7dc9e6b6d0c7d0929115aeb1339a46b990ab4403498fca158eac5b034149e`.
- RED 46 is a fail-fast source-shape guard that rejects `spliceOffsets.some()` multiplicative matching before an unsafe stress input executes. The replacement builds one normalized view, keeps only scalar removed-length and `lastSpliceOffset` state, and checks the first normalized credential assignment, giving linear traversal without a per-splice offset/chunk collection. Restoring the old algorithm reproduces the exact RED. RED and mutation logs both have SHA-256 `75fc0813c5e789868e37584eca053a34967199b0c8158b4898d6fc2ee4b13b05`.
- GREEN also runs the reviewer's near-2-MiB shape—40,000 Authorization assignments plus 300,000 shell splices—through the real handler, requires completion under ten seconds, verifies the sentinel is absent, and requires `[REDACTED_SHELL_SPLICED_HEADER]` in persisted evidence.

The frozen `1ab0a74cad346cdfee25cf2d38bd5ee7bc40d74ed6d18d086fa3934f1e208fc0` candidate passed exact source/artifact/privacy/replay/freeze/security gates and received fresh specification/privacy PASS. Quality review required stronger behavioral proof that a renamed nested span search could not evade the source-shape guard. The candidate, both PASS verdicts, and all tied gates are invalidated. No commit or deployment occurred.

- RED 47 first makes post-run fail when the complementary stress contract is absent (log SHA-256 `6a9cb609b57de5ae86fa02fccbb1edc36b37b779147898afe9447eca456b8716`). GREEN adds a small functional case plus a second near-2-MiB real-handler shape with 300,000 splices, a non-empty safe gap, then 40,001 Authorization assignments. Its normalized `lastSpliceOffset` is strictly less than the first assignment offset, so the prior span-based nested search would perform more than ten billion comparisons instead of short-circuiting. The candidate must finish under ten seconds and retain a safe head marker; the small case separately proves ordinary credential redaction because the large item's 1,200-character evidence cap intentionally hides distant markers. Removing the safe gap makes the offsets equal and reproduces deterministic RED before handler execution (mutation log SHA-256 `a5f42c6fa21ae29aa263efc29873e7a039a691e84d66f5e9748fd9747df0b8d1`). Together with the assignments-before-splices stress, this covers both orderings and both fail-safe outcomes.

Targeted GREEN runs cover `test:core`, `test:p1c`, and `test:resilience`. Fresh aggregate, packaged-artifact, replay, security, candidate-freeze, and three-way independent reviews are required below before commit.

## Replacement-candidate gates

The candidate frozen as `c4f10c9b0bad800ab4f8188c39b42510a28325653feb481035d1b885921f2d8b` received a fresh specification PASS but a fresh HIGH quality FAIL for concurrent stale recovery. The later `65f34b7569f82a09865dddc2e05f5d8aa4a77464602ce8cff99dc7c1617a7ba6` candidate closed that race and received a filesystem-lock quality PASS, but fresh specification and security reviews found RED/GREEN 26–30. Both candidates and all artifact/replay/review evidence tied to them are invalidated and are not reused.

Historical, invalidated evidence observed after RED/GREEN 25 and its mutation proof (retained only to explain the superseded candidate):

- six Node syntax checks: all exit `0`;
- `npm test`: exit `0`, including `concurrentStaleRecoveryExclusion:"pass"` and `interruptedRecoveryMarker:"fail-closed-pass"`;
- `npm run postrun:check`: exit `0`;
- staged and unstaged `git diff --check`: exit `0`;
- fresh npm artifact: 10 files, 63,701 bytes packed / 297,524 bytes unpacked, SHA-256 `257fe80df1cc655c16014b5944d07ddcadbbae70c5273c69bf46e22d47ae12da`;
- every packaged file is byte-identical to the corresponding source file; unpacked `npm test` and `postrun:check` both exit `0` and include both new lock-recovery machine fields;
- three fresh source replay rounds each include full `npm test`, post-run, child-process one-shot, concurrent stale-recovery exclusion, interrupted-marker fail-closed, and opened-transcript identity checks. Log SHA-256 values: `86c41a0b4e6dbcf3f851bcf416c24c9fab9e2aaea52c5fc9f82df137230aac5e`, `d633eeab99d725568e73aefaa2078f9dfd6293094da6b90021ddd6beb40c7418`, and `dc0e1e19db45bb168f6daafcbaaee48fc558c83beddf8b441835696730fafeb5`;
- added-handler security scan finds no dynamic evaluation, production child-process execution, shell execution, credential literals, raw corrupt-state persistence, or raw error logging, and confirms a fixed O_EXCL/no-follow recovery marker.

For the RED/GREEN 26–30 replacement, final source, artifact, replay, security, staged-diff, and independent-review hashes are frozen only after this tracked evidence file stops changing. Those exact hashes are kept in the external freeze/review report rather than embedded in the tarball, avoiding a self-referential artifact hash.

Exact candidate freeze and all fresh specification, quality/correctness, and security reviews remain required before commit.
