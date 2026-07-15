# P1-A TDD Evidence

Date: 2026-07-15
Scope: provenance-aware, non-recursive, bounded compact handoff v2

## Evidence policy

Two delegated implementation attempts timed out without a completion summary. Their self-reports are therefore not accepted as TDD evidence. The parent Hermes re-read the actual files and independently reran the tests.

An initial detached-baseline replay was accidentally invoked from the main repository working directory. It returned PASS but did not exercise the detached baseline; that result was explicitly discarded and is not used below.

## Baseline RED

A detached worktree at baseline commit `9f70a9393886a402c9d94403fc5056f0b464e288` was created. The new test script was copied into that worktree and executed from the detached worktree directory.

Command:

```bash
cd /tmp/openclaw-compact-handoff-p1a-baseline
npm test
```

Result: exit 1.

First expected regression:

```text
Error: synthetic metadata message replaced the latest real user request
```

This proves the baseline implementation did not satisfy the new provenance requirement.

## Parent continuation RED

After recovering the timeout worker's partial changes, the parent added tests for the still-missing requirements before changing production code:

- no empty operator fill-in template
- session bootstrap hard cap of 8,000 characters
- project pointer hard cap of 2,000 characters
- combined compact-handoff bootstrap hard cap of 10,000 characters
- UTF-16-safe clipping of an oversized legacy v1 bootstrap

Command:

```bash
npm test
```

Result: exit 1.

Expected failure:

```text
Error: handoff must not emit an empty operator fill-in template
```

## GREEN

Production code was then changed to remove the empty template and apply UTF-16-safe hard caps to both new and legacy handoffs.

Commands:

```bash
npm test
npm run postrun:check
git diff --check
```

Results:

- `npm test`: exit 0; deterministic hook fixture returned `ok: true`
- `npm run postrun:check`: exit 0; all seven post-run checks PASS
- `git diff --check`: exit 0

## Independent spec-review RED and fix

The first independent specification review returned `passed: false` and produced four focused counterexamples:

1. redaction expansion could grow a pre-clipped evidence item beyond 1,200 characters;
2. user-role `System notice:` could be treated as a real user request;
3. a markdown-framed `## memory/session_handoffs/...` block could bypass the recursion filter;
4. `allowed_actions` and `forbidden_actions` each received a separate 20-item allowance, permitting 40 aggregate references.

Tests for all four counterexamples were added before the corrective handler changes. The first rerun failed as expected:

```text
Error: redaction-expanded evidence exceeded 1200-char hard cap: 2343
```

The implementation was then corrected to redact before the final evidence cap, recognize narrow System notices, filter framed handoff blocks, and allocate one aggregate 20-item round-robin budget across allowed and forbidden references.

Final commands:

```bash
npm test
npm run postrun:check
git diff --check
```

Final result: all commands exit 0.

## Second independent spec-review RED and fix

The second independent specification review found two additional cap-ordering problems:

1. selecting the final 24 messages before choosing priority fields allowed 24 synthetic notices to displace the latest genuine user and assistant messages;
2. rendering all allowed references before forbidden references allowed the final 2,000-character pointer cap to remove the forbidden group.

Both counterexamples were added to the tests first. The priority-tail test failed as expected:

```text
Error: 24-message synthetic tail displaced the latest real user request
```

The reader now tracks the latest genuine user and assistant across the scan and reserves two of the 24 bounded slots for them. The project pointer applies bounded per-group rendering before the final 2,000-character cap, while retaining one aggregate 20-reference allocation.

The first long-reference fixture used hundreds of repeated `A`/`F` characters. The existing generic long-token scrubber correctly redacted those values, making sentinel counting invalid. That fixture was corrected to use long, non-secret safe paths; the production redaction rule was not weakened.

Final commands after the correction:

```bash
npm test
npm run postrun:check
node --check hooks/compact-handoff/handler.ts
node --check scripts/test_compact_handoff_hook.mjs
git diff --check
```

Final result: all commands exit 0.

## Independent specification gate

The final broad re-review timed out without a verdict and is not counted as evidence. A short independent recheck then verified only the two newest fixes, while relying on the previous full reviewer’s independent confirmation that the first four counterexamples were already fixed.

The focused reviewer returned `passed: true` and independently observed:

- priority-tail fixture retained both the genuine user request and assistant status;
- exactly 24 bounded evidence entries;
- generated project pointer stayed below 2,000 characters;
- both long non-secret allowed and forbidden safe-path references remained represented;
- aggregate rendered references stayed below the 20-item limit;
- the secret scrubber was not weakened;
- `npm test`, `npm run postrun:check`, both Node syntax checks, and `git diff --check` all exited 0.

P1-A specification compliance is therefore PASS. Code-quality review remains a separate gate.

## Independent quality-review RED and fix

The first independent code-quality review returned `passed: false` with two important findings:

1. priority messages were prepended to the bounded evidence array, but reverse lookup could then select older user/assistant entries from the tail;
2. broad text-only `System notice:` and `Gateway notice:` prefixes could discard a genuine pasted-log-plus-question request.

Tests were expanded first with an ordinary old/latest multi-turn sequence and a genuine user request beginning with `System notice:`. The suite failed as expected:

```text
Error: narrow synthetic recognizers discarded a genuine runtime-prefixed user request
```

The implementation now:

- retains a bounded 24-item rolling tail instead of materializing an object for every transcript row;
- tracks the latest real user and assistant separately;
- merges required priority entries back into the bounded set and sorts by original ordinal before reverse lookup;
- treats metadata as authoritative for synthetic messages;
- limits text-only Gateway/System fallbacks to complete, known runtime envelope strings rather than arbitrary prefixes.

After narrowing the fallback, the 24-message synthetic-tail fixture was corrected to include `metadata.synthetic=true`, matching the intended metadata-first provenance model. The production recognizer was not broadened again.

Commands after the fix:

```bash
npm test
npm run postrun:check
node --check hooks/compact-handoff/handler.ts
node --check scripts/test_compact_handoff_hook.mjs
git diff --check
```

All commands exit 0. The review's same-second archive filename observation is deferred to P1-B atomic write/unique archive/retention work and is not represented as complete here. Independent quality re-review is still required.

The focused independent quality re-review returned `passed: true`, with no important findings. It independently verified correct latest-message ordering, metadata-first provenance, narrow anchored text fallbacks, a bounded 24-item reader, unchanged redaction, and all five local commands exiting 0.

Its only minor note was that the regression test inferred rather than directly asserted the Recent Conversation Extract count and chronological ordering. The test now explicitly asserts exactly 24 headings, latest user before latest assistant before retained synthetic notices, and omission of displaced old user/assistant entries. The full local gate remained green after this test strengthening.

P1-A specification and code-quality gates are both PASS.

## Covered behavior

- synthetic approval/memory-flush/runtime notices cannot replace the latest real user request
- previous handoff and bootstrap blocks are not recursively copied
- schema version 2 and unique non-empty generation IDs
- handoff body <= 8,000 characters
- project pointer <= 2,000 characters
- combined custom bootstrap <= 10,000 characters
- individual evidence <= 1,200 characters
- exact-reference arrays <= 20 entries
- CJK/emoji clipping has no dangling surrogate or U+FFFD
- oversized legacy v1 handoff is capped during bootstrap
- empty operator checklist is absent

No live hook, OpenClaw config, Gateway, Node, package installation, or remote Git state was changed during P1-A.
