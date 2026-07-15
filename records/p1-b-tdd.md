# P1-B TDD Record — Runtime Resilience

Base commit: `0acd4790ed26ecc76dfd24b5c31376042b9f666d`

Scope: early-write throttling, atomic local persistence, serialized/corrupt-safe index updates, unique archives, retention, and expanded secret scrubbing. This sub-phase does **not** claim P1-C injection lifecycle or native-summary audit behavior.

## RED 1 — resilience suite before implementation

A new deterministic suite, `scripts/test_compact_handoff_resilience.mjs`, was wired into `npm test` before production changes.

Command:

```bash
npm test
```

Observed result: exit `1`.

First counterexample:

```text
Error: same-second archives were not unique:
["20260715T201115_before_agent:main:same-second.md"]
```

This proved that second-resolution archive names overwrote one another.

The same suite also specifies:

- twenty concurrent session writes must all survive in `index.json`;
- malformed indexes must be preserved as `index.json.corrupt-*` before rebuild;
- archives are capped at five per session/phase and thirty days;
- current/state/index files are not retention targets;
- bearer, GitHub/Slack, cookie, secret-query, and private-key fixtures are scrubbed;
- ordinary snowflakes, commit SHAs, paths, and issue URLs survive;
- 75% pressure and 10K token delta cannot bypass a five-minute hard floor;
- a soft-to-high bucket change after five minutes and normal twenty-minute interval do refresh;
- no temp artifacts remain.

## GREEN 1 — runtime resilience implementation

Implemented:

- temp-file + file sync + rename writes for archive/current/state/index;
- best-effort directory sync after rename;
- UUID archive suffixes;
- a serialized in-process index update queue;
- corrupt-index preservation and rebuild;
- archive pruning after a successful write/index update;
- five-minute hard floor and twenty-minute normal early refresh;
- expanded redaction corpus.

Command:

```bash
npm test
```

Observed result: exit `0`.

Resilience summary:

```json
{"ok":true,"collisionArchives":2,"concurrentSessions":20,"corruptCopies":1,"retainedArchives":5,"evidenceSecrets":8,"throttle":"hard-floor-pass"}
```

## RED 2 — valid JSON with invalid index shape

The corruption test was then strengthened from invalid JSON to a syntactically valid index containing `{"sessions":[]}`.

Command:

```bash
npm run test:resilience
```

Observed result: exit `1`.

Counterexample:

```text
Error: valid JSON with an invalid sessions shape was not recovered fail-closed
```

## GREEN 2 — shape validation

`readIndexForUpdate()` now rejects a non-object `sessions` value, preserves the old file as `index.json.corrupt-*`, and rebuilds a valid object index.

Command:

```bash
npm test
```

Observed result: exit `0`.

The run emitted two expected, content-free recovery warnings:

- invalid JSON parse failure;
- `index sessions is not an object`.

Both prior index files were preserved outside the live index path.

## Flake replay

Command:

```bash
for i in $(seq 1 10); do npm run test:resilience; done
```

Observed result: all ten iterations exited `0`. Every run reported two unique same-second archives, twenty concurrent sessions retained, corrupt-index preservation, five retained archives, eight secret classes scrubbed, and a passing throttle hard floor.

## RED 3 — retention session-prefix isolation

A neighboring session whose slug begins with the target slug (for example, `agent:main:retention_neighbor`) was given six archives. Running retention for `agent:main:retention` must not touch those files.

Command:

```bash
npm run test:resilience
```

Observed result: exit `1`.

Counterexample:

```text
Error: retention crossed a session-slug boundary and deleted a neighbor archive
```

## GREEN 3 — unambiguous archive identity boundary

New archives use `sessionSlug~uuid`; `safeSlug()` cannot emit `~`. Retention now accepts only an exact legacy slug or the exact `sessionSlug~` boundary, so prefix-neighbor sessions are isolated. The test's archive counter uses the same exact boundary.

Commands:

```bash
npm test
npm run postrun:check
git diff --check
```

Observed result: all exit `0`; target retention reports five archives and all six neighbor archives remain readable.

## RED 4 — concurrent early first-crossing race

Two simultaneous `message:preprocessed` events for the same session both observed an empty state and wrote an early archive, bypassing the intended hard floor.

Command:

```bash
npm run test:resilience
```

Observed result: exit `1` with:

```text
Error: concurrent first crossing bypassed early-write serialization: 2
```

## GREEN 4 — keyed early-write queue

The complete state-read, threshold decision, handoff/index write, and state-write sequence is serialized by workspace and session identity. Different sessions remain independently schedulable.

Commands:

```bash
npm test
npm run postrun:check
git diff --check
```

Observed result: all exit `0`; the concurrent first-crossing fixture emits exactly one early archive.

The final queue-enabled candidate was then replayed five additional times with `npm run test:resilience`; all five exited `0` and retained the one-write concurrent first-crossing assertion.

## Independent spec review RED — directional bucket transition

The first independent P1-B specification review returned `passed: false`. Its targeted probe found that the implementation refreshed after a high-to-soft transition at six minutes because it accepted any bucket change. The requirement allows only soft-to-high.

The resilience suite was extended with a negative high-to-soft fixture before production code changed.

Command:

```bash
npm run test:resilience
```

Observed result: exit `1` with:

```text
Error: high-to-soft pressure change incorrectly triggered an early refresh
```

The refresh predicate was then narrowed to:

```text
lastBucket === "soft" && bucket === "high" && hardFloorElapsed
```

`HOOK.md` now says soft-to-high explicitly and states that high-to-soft alone does not write.

Commands:

```bash
npm test
npm run postrun:check
node --check hooks/compact-handoff/handler.ts
node --check scripts/test_compact_handoff_resilience.mjs
git diff --check
```

Observed result: all exit `0`; resilience reports `"throttle":"hard-floor-and-direction-pass"`.

### Focused specification recheck

A separate read-only reviewer then returned `passed: true` with no `missing_or_wrong` findings. It independently confirmed the exact directional predicate, positive delta and interval paths, hard-floor negative tests, keyed early-write queue, `sessionSlug~` retention boundary, updated documentation, and the required command suite.

P1-B specification compliance is therefore PASS. Code-quality/security review remains a separate gate.

## RED 6 — published package omitted the checker

The package declared `npm run postrun:check`, but `scripts/post_run_check.mjs` was absent from the `package.json.files` publish allowlist. A new self-check assertion failed before the allowlist changed:

```text
FAIL package ships runnable checks
post-run check failed: 1 issue(s)
```

After adding the checker to `files`, `npm run postrun:check` exited `0`. `npm pack --dry-run --json` independently listed eight package entries, including both test scripts and `scripts/post_run_check.mjs`.

## Independent quality/security review RED

The first read-only quality review returned `passed: false` with six important findings despite the standard suites passing:

1. quoted JSON credentials, inline `Cookie:` headers, and unterminated PEM blocks could persist in plaintext;
2. malformed-index parser excerpts could be echoed in warnings;
3. concurrent before/after writes for one session could leave current and indexed archive generations different;
4. lossy session slugs allowed distinct raw keys to share current/state/archive ownership;
5. a future persisted timestamp could suppress high-pressure refreshes until wall-clock catch-up;
6. non-corruption index read failures were quarantined as corruption and could replace live index data.

The reviewer also noted four minor issues: successful tests did not remove temporary trees, atomic failure paths lacked direct injection tests, the index queue was process-global across workspaces, and retention deleted through an unbounded `Promise.all`.

### RED 7 — quality/security regression batch

The resilience suite was expanded before production fixes with fixtures for all six important findings. Reproducible RED evidence included:

```text
Error: corrupt-index warning echoed attacker-controlled secret input
Error: non-corruption index read failure was mislabeled and quarantined as corrupt
Error: non-corruption index read failure left current handoff inconsistent with the live index
```

The independent review's stress probe had also observed 18 current/index mismatches in forty rounds of eight same-session writes and a five-to-four archive loss after writing a colliding raw session key.

### GREEN 5 — security and transaction hardening

The candidate now:

- scrubs quoted JSON credentials, inline cookies, and both complete and unterminated PEM blocks;
- logs only an OS error code/error class for every warning, never a raw `error.message`, parser excerpt, or `String(error)`;
- separates read I/O errors from JSON/shape corruption, so `EACCES` and other non-corruption failures abort without quarantine;
- serializes the full handoff transaction per workspace/session and serializes index commits per index path;
- reads the live index before replacing current, and restores the previous current if the subsequent index write fails;
- derives a readable storage ID with a 128-bit SHA-256 suffix whenever raw session-key normalization or truncation would otherwise be lossy;
- treats a persisted future timestamp as a clock-recovery refresh and rewrites normalized state;
- removes successful core/resilience temporary trees;
- scopes index queues per index path and unlinks retention candidates sequentially.

The strengthened resilience run now reports:

```json
{"evidenceSecrets":11,"sameSessionTransactionRounds":40,"slugCollisionIsolation":"pass","throttle":"hard-floor-and-direction-pass","cleaned":true}
```

It also verifies that a forced `EACCES` preserves both the prior live index entry and the generation of its current handoff.

Commands:

```bash
npm test
npm run postrun:check
node --check hooks/compact-handoff/handler.ts
node --check scripts/test_compact_handoff_hook.mjs
node --check scripts/test_compact_handoff_resilience.mjs
node --check scripts/post_run_check.mjs
git diff --check
npm pack --dry-run --json
```

Observed result: all exit `0`; the post-run gate reports eighteen PASS checks, and the dry-run package manifest contains the expected eight files. The final quality candidate also passed five consecutive resilience replays (200 same-session rounds total, eight concurrent writes per round), with collision isolation, eleven secret classes, and cleanup assertions passing every time. A fresh independent quality/security recheck is still required before commit.

## Final specification recheck RED — ambiguous archive delimiter and missing positive delta fixture

A final read-only specification review of the post-quality-fix candidate returned `passed: false` with two findings:

1. a lossless storage ID such as `agent:main:a_b` treated the lossy ID `agent:main:a_b~<digest>` as its own archive prefix, so retention could delete another session's archives;
2. production supported a high-to-high `>=10K` token delta after the five-minute floor, but the resilience suite lacked the required positive generation assertion before the twenty-minute interval.

The reviewer reproduced the first issue as a five-to-four lossy archive loss. The expanded local fixture, which includes two lossy sessions plus the lossless prefix session, produced this RED before production changed:

```text
Error: lossless storage ID crossed lossy archive ownership: {"a":3,"b":1,"lossless":1}
```

### GREEN 6 attempt — delimiter-only boundary (rejected)

The first fix changed archive instances to `--<uuid>` and added the positive post-floor 10K delta assertion. That solved lossless-versus-lossy storage IDs, but its stated invariant was wrong: `safeSlug()` permits literal hyphens, so a safe child ID such as `agent:main:a_b--neighbor` still matched the parent prefix. Both the final specification reviewer and final quality reviewer rejected this candidate.

The expanded safe-parent/safe-child fixture reproduced the second ownership bug:

```text
Error: lossless storage ID crossed lossy archive ownership: {"a":5,"b":1,"lossless":1,"delimiterNeighbor":4}
```

### GREEN 7 — exact UUID ownership grammar, complete delta coverage, and retention transaction closure

Archive ownership now uses `@<uuid>` for new instances. `safeSlug()` excludes `@`, and lossy/truncated storage IDs only append `~<sha256>`, so no storage ID can contain the separator. Retention accepts only either an exact legacy storage ID or a suffix whose entire remainder is `@<uuid>`; a plain prefix is never sufficient. This also avoids confusing a legacy child ID ending in UUID-like text with a new parent archive. The fixture covers lossy `a/b`, lossy `a?b`, safe `a_b`, and safe child `a_b--neighbor`, preserving archive counts `5/1/2/5` after the parent writes again.

The throttle fixture sets a high-bucket state six minutes old, advances from 7,600 to 17,600 tokens, and requires a new generation before separately proving the twenty-minute interval path.

Two prior quality minors also received deterministic RED→GREEN coverage before the next final review:

- an index I/O failure must remove the just-written uncommitted archive and sync the directory;
- retention must pin the archive referenced by the committed index even when five other archives have future mtimes.

Commands:

```bash
npm run test:resilience
```

Observed focused result: exit `0`; exact UUID ownership, safe delimiter-neighbor isolation, positive post-floor 10K delta, orphan cleanup, and committed-archive pinning all pass. Fresh final specification and quality reviews are required before commit.

## Final directional-throttle review RED

The next independent specification review returned `passed: false`; its paired quality review timed out and therefore supplied no usable verdict. The specification reviewer reproduced two over-broad refresh paths that the existing suite had not covered:

1. the unconditional twenty-minute branch wrote a high-to-soft handoff after twenty-one minutes;
2. the generic 10K branch wrote a soft-to-soft handoff after six minutes.

The local regression first reproduced the interval defect:

```text
Error: high-to-soft pressure change incorrectly triggered after the normal interval
```

### GREEN 8 — strictly directional interval/delta refresh

The predicate now applies these exact rules after the five-minute floor:

- soft-to-high: write;
- high-to-high with a positive 10K delta: write;
- twenty-minute interval: write only when the transition is not high-to-soft;
- high-to-soft: never write;
- soft-to-soft +10K: do not write.

A no-write downward observation atomically persists `lastObservedBucket: soft` without changing the last-handoff time/tokens/bucket. This preserves a pending soft-to-high transition: a rise suppressed inside the hard floor remains eligible once five minutes have elapsed.

Focused command:

```bash
npm run test:resilience
```

Observed result: exit `0`; twenty-one-minute high-to-soft suppression, soft-to-soft +10K suppression, observed soft-to-high recovery, high-to-high +10K, hard-floor, interval, and future-clock assertions all pass. Fresh specification and quality reviews remain required before commit.

## Final quality review RED — quoted Cookie values

The GREEN 8 specification review passed. The paired quality/security review returned `passed: false` because the Cookie/Set-Cookie regex stopped at either quote. A valid line such as `Cookie: sid="PLAINTEXT_SECRET"` could therefore persist the quoted value after the prefix was replaced. The reviewer also noted that the rollback path after current replacement but before index commit had no direct failure fixture.

The quoted-cookie regression first reproduced the leak:

```text
Error: plaintext secret leaked into handoff: quotedCookie
```

### GREEN 9 — quoted-cookie scanner and rollback fixture

Cookie redaction now uses a deterministic, line-bounded scanner:

- ordinary Cookie/Set-Cookie headers are replaced through end-of-line;
- shell-quoted inline headers are replaced through the matching unescaped quote;
- escaped inner quotes cannot terminate redaction early;
- the closing shell quote and following safe URL remain intact.

The corpus now covers standalone quoted Cookie, quoted Set-Cookie, single-quoted shell headers, double-quoted shell headers with escaped inner quotes, and preservation of a following non-secret URL. All thirteen named secret values are absent from the persisted handoff.

A separate injected EIO fixture fails only the atomic rename to `index.json`, after the new current file has already been installed. It verifies that the old current generation is restored, the raw live index bytes are unchanged, the uncommitted archive is removed, and the injected failure point was actually reached.

Focused commands:

```bash
npm run test:resilience
```

Observed result: exit `0`; `evidenceSecrets: 13`, quoted-cookie variants and safe URL preservation pass, and `indexRenameRollback: pass` is emitted.

## Final independent review gate — PASS

Both reviewers inspected the same stable GREEN 9 snapshot read-only.

- Specification: `passed: true`, with no missing or wrong requirements.
- Quality/security: `passed: true`, with zero critical, important, or minor findings.
- Both independently ran `npm test`, `npm run postrun:check`, all four syntax checks, and `git diff --check` successfully.
- The quality reviewer specifically verified scanner monotonicity/line bounds/escaped quotes and the post-current EIO rollback fixture's isolation and cleanup.

P1-B is approved for a verified local commit. Deployment, restart, and live configuration remain outside this commit gate.

## Post-run/static gate

Command:

```bash
npm run postrun:check
```

Observed result: exit `0`.

Checks passed for:

- package/hook registration;
- resilience-suite registration;
- session-only current path and no global fallback;
- v2 hard budgets;
- atomic write helper;
- serialized/corrupt-safe index path;
- archive retention;
- early refresh hard floor;
- expanded secret scrubber;
- complete `npm test` execution.

## Safety and scope

- No OpenClaw config was changed.
- No plugin was installed or deployed.
- No gateway was restarted.
- No production handoff/index/state file was modified.
- No network call, push, or PR occurred.
- All test artifacts were created under temporary directories.
