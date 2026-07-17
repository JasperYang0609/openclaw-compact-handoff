import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import rawHandler from '../hooks/compact-handoff/handler.ts';
import { createSessionAuthorityHarness } from './test_session_authority.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-p1c-audit-'));
const sessionAuthority = await createSessionAuthorityHarness(rawHandler, root);
const { handler } = sessionAuthority;
const handoffDir = path.join(root, 'memory/session_handoffs');
await fs.mkdir(handoffDir, { recursive: true });

function currentPath(sessionKey) {
  return path.join(handoffDir, `session_${sessionKey}.MEMORY.md`);
}

function afterEvent(sessionKey, sessionFile, overrides = {}) {
  return {
    type: 'session',
    action: 'compact:after',
    sessionKey,
    timestamp: new Date().toISOString(),
    messages: [],
    context: {
      workspaceDir: root,
      sessionEntry: { sessionId: `${sessionKey}-id`, sessionFile },
      compactedCount: 10,
      summaryLength: overrides.summaryLength,
      tokensBefore: 20000,
      tokensAfter: 9000,
    },
  };
}

function parseAuditFromIndex(index, sessionKey) {
  const audit = index.sessions?.[sessionKey]?.nativeSummaryAudit;
  if (!audit || typeof audit !== 'object') {
    throw new Error(`index missing nativeSummaryAudit for ${sessionKey}`);
  }
  const keys = Object.keys(audit);
  const allowedKeys = new Set(['available', 'ok', 'reasons', 'summaryLength']);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new Error(`nativeSummaryAudit persisted a non-allowlisted key for ${sessionKey}: ${keys.join(',')}`);
  }
  if (typeof audit.available !== 'boolean'
      || !Array.isArray(audit.reasons)
      || ('ok' in audit && typeof audit.ok !== 'boolean')
      || ('summaryLength' in audit && (!Number.isInteger(audit.summaryLength) || audit.summaryLength < 0))) {
    throw new Error(`nativeSummaryAudit persisted an invalid schema for ${sessionKey}: ${JSON.stringify(audit)}`);
  }
  for (const reason of audit.reasons) {
    if (!fixedAuditReasons.has(reason)) {
      throw new Error(`nativeSummaryAudit persisted a non-allowlisted reason for ${sessionKey}: ${reason}`);
    }
  }
  return audit;
}

const requiredHeadings = [
  '## Decisions',
  '## Open TODOs',
  '## Constraints/Rules',
  '## Pending user asks',
  '## Exact identifiers',
];
const fixedAuditReasons = new Set([
  'session-file-unavailable',
  'session-tail-read-failed',
  'compaction-entry-not-found-in-bounded-tail',
  'latest-compaction-summary-unavailable',
  'summary-too-long',
  'summary-not-structured',
  ...requiredHeadings.map((heading) => `missing-required-section:${heading.slice(3)}`),
  'latest-user-request-missing',
  'exact-reference-missing',
]);
const goodLatestAsk = 'AUDIT_LATEST_ASK_界 please preserve exact audit evidence';
const goodCommit = '0123456789abcdef0123456789abcdef01234567';
const goodPath = '/Users/example/project/src/audit-target.ts';
const goodSummary = [
  '## Decisions',
  `- Preserve ${goodCommit}.`,
  '',
  '## Open TODOs',
  `- Continue ${goodLatestAsk}.`,
  '',
  '## Constraints/Rules',
  '- Read only a bounded transcript tail.',
  '',
  '## Pending user asks',
  `- ${goodLatestAsk}`,
  '',
  '## Exact identifiers',
  `- ${goodPath}`,
].join('\n');
const goodSessionKey = 'agent:main:p1c-audit-good';
const goodSessionFile = path.join(root, 'p1c-audit-good.jsonl');
const goodCanonicalSessionFile = sessionAuthority.canonicalSessionPath(goodSessionKey, `${goodSessionKey}-id`);
const oversizedPrefix = `${'P'.repeat((2 * 1024 * 1024) + 131)}\n`;
await fs.writeFile(goodSessionFile, oversizedPrefix + [
  JSON.stringify({ type: 'message', message: { role: 'user', content: goodLatestAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Working at ${goodPath}; commit ${goodCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
].join('\n'));

const originalReadFile = fs.readFile;
const originalOpenForBoundedTail = fs.open;
const goodSessionStat = await fs.stat(goodSessionFile);
const expectedTailStart = Math.max(0, goodSessionStat.size - (2 * 1024 * 1024));
let forbiddenFullTranscriptReads = 0;
let boundedTailOpenCount = 0;
let boundedTailRequestedBytes = 0;
let boundedTailReadBytes = 0;
const boundedTailReadPositions = [];
fs.readFile = async (target, ...args) => {
  if (String(target) === goodCanonicalSessionFile) {
    forbiddenFullTranscriptReads += 1;
    throw Object.assign(new Error('full transcript read forbidden by P1-C fixture'), { code: 'EFBIG' });
  }
  return originalReadFile.call(fs, target, ...args);
};
fs.open = async (target, ...args) => {
  const handle = await originalOpenForBoundedTail.call(fs, target, ...args);
  if (String(target) === goodCanonicalSessionFile) {
    boundedTailOpenCount += 1;
    const originalHandleRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      boundedTailRequestedBytes += length;
      boundedTailReadPositions.push(position);
      const result = await originalHandleRead(buffer, offset, length, position);
      boundedTailReadBytes += result.bytesRead;
      return result;
    };
  }
  return handle;
};
try {
  await handler(afterEvent(goodSessionKey, goodSessionFile, { summaryLength: goodSummary.length }));
} finally {
  fs.readFile = originalReadFile;
  fs.open = originalOpenForBoundedTail;
}
if (forbiddenFullTranscriptReads !== 0) {
  throw new Error(`post-compaction path attempted ${forbiddenFullTranscriptReads} unbounded transcript read(s)`);
}
if (boundedTailOpenCount !== 1
    || boundedTailReadPositions.length !== 1
    || boundedTailReadPositions[0] !== expectedTailStart
    || boundedTailRequestedBytes > 2 * 1024 * 1024
    || boundedTailReadBytes > 2 * 1024 * 1024) {
  throw new Error(`bounded/shared transcript tail invariant failed: ${JSON.stringify({
    boundedTailOpenCount,
    boundedTailReadPositions,
    expectedTailStart,
    boundedTailRequestedBytes,
    boundedTailReadBytes,
  })}`);
}
const originalOpenForStoreCache = fs.open;
let cachedStoreOpenCount = 0;
let cachedStoreReadCount = 0;
let cachedStoreStatCount = 0;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForStoreCache.call(fs, target, ...args);
  if (String(target) === sessionAuthority.sessionsStorePath) {
    cachedStoreOpenCount += 1;
    const originalHandleRead = handle.read.bind(handle);
    const originalHandleStat = handle.stat.bind(handle);
    handle.read = async (...readArgs) => {
      cachedStoreReadCount += 1;
      return originalHandleRead(...readArgs);
    };
    handle.stat = async (...statArgs) => {
      cachedStoreStatCount += 1;
      return originalHandleStat(...statArgs);
    };
  }
  return handle;
};
try {
  await handler(afterEvent(goodSessionKey, goodSessionFile, { summaryLength: goodSummary.length }));
} finally {
  fs.open = originalOpenForStoreCache;
}
if (cachedStoreOpenCount !== 1 || cachedStoreStatCount !== 1 || cachedStoreReadCount !== 0) {
  throw new Error(`unchanged authoritative sessions store bypassed identity cache: ${JSON.stringify({
    cachedStoreOpenCount,
    cachedStoreStatCount,
    cachedStoreReadCount,
  })}`);
}
const replacedGoodSession = await sessionAuthority.registerSessionFixture(
  goodSessionKey,
  `${goodSessionKey}-id`,
  goodSessionFile,
  { totalTokens: 1 },
);
const replacementEvent = afterEvent(goodSessionKey, goodSessionFile, { summaryLength: goodSummary.length });
replacementEvent.context.sessionEntry.sessionId = replacedGoodSession.sessionId;
replacementEvent.context.sessionEntry.sessionFile = replacedGoodSession.sessionFile;
const originalOpenForStoreInvalidation = fs.open;
let invalidatedStoreOpenCount = 0;
let invalidatedStoreReadCount = 0;
let invalidatedStoreStatCount = 0;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForStoreInvalidation.call(fs, target, ...args);
  if (String(target) === sessionAuthority.sessionsStorePath) {
    invalidatedStoreOpenCount += 1;
    const originalHandleRead = handle.read.bind(handle);
    const originalHandleStat = handle.stat.bind(handle);
    handle.read = async (...readArgs) => {
      invalidatedStoreReadCount += 1;
      return originalHandleRead(...readArgs);
    };
    handle.stat = async (...statArgs) => {
      invalidatedStoreStatCount += 1;
      return originalHandleStat(...statArgs);
    };
  }
  return handle;
};
try {
  await sessionAuthority.rawHandler(replacementEvent);
} finally {
  fs.open = originalOpenForStoreInvalidation;
}
if (invalidatedStoreOpenCount !== 1 || invalidatedStoreStatCount !== 2 || invalidatedStoreReadCount < 1) {
  throw new Error(`replaced authoritative sessions store reused a stale identity cache entry: ${JSON.stringify({
    invalidatedStoreOpenCount,
    invalidatedStoreStatCount,
    invalidatedStoreReadCount,
  })}`);
}

const storeSafetySessionKey = 'agent:main:p1c-store-safety';
const storeSafetySource = path.join(root, 'p1c-store-safety.jsonl');
const storeSafetySentinel = 'P1C_UNSAFE_SESSIONS_STORE_MUST_NOT_BIND';
await fs.writeFile(storeSafetySource, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: storeSafetySentinel } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
].join('\n'));
const storeSafetyAuthority = await sessionAuthority.registerSessionFixture(
  storeSafetySessionKey,
  'p1c-store-safety-id',
  storeSafetySource,
);
const safeSessionsStoreBytes = await fs.readFile(sessionAuthority.sessionsStorePath);
async function assertUnsafeStoreDidNotBind(label) {
  const event = afterEvent(storeSafetySessionKey, storeSafetySource, { summaryLength: goodSummary.length });
  event.context.sessionEntry.sessionId = storeSafetyAuthority.sessionId;
  event.context.sessionEntry.sessionFile = storeSafetyAuthority.sessionFile;
  await sessionAuthority.rawHandler(event);
  const handoff = await fs.readFile(currentPath(storeSafetySessionKey), 'utf8');
  if (handoff.includes(storeSafetySentinel)) {
    throw new Error(`${label} sessions store was accepted as authoritative`);
  }
}

try {
  await fs.chmod(sessionAuthority.sessionsStorePath, 0o622);
  await assertUnsafeStoreDidNotBind('group/world-writable');
} finally {
  await fs.chmod(sessionAuthority.sessionsStorePath, 0o600);
}

const originalOpenForStoreOwner = fs.open;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForStoreOwner.call(fs, target, ...args);
  if (String(target) === sessionAuthority.sessionsStorePath) {
    const originalHandleStat = handle.stat.bind(handle);
    handle.stat = async (...statArgs) => {
      const stat = await originalHandleStat(...statArgs);
      return new Proxy(stat, {
        get(object, property, receiver) {
          if (property === 'uid') return object.uid + 1;
          const value = Reflect.get(object, property, receiver);
          return typeof value === 'function' ? value.bind(object) : value;
        },
      });
    };
  }
  return handle;
};
try {
  await assertUnsafeStoreDidNotBind('foreign-owner');
} finally {
  fs.open = originalOpenForStoreOwner;
}

const storeSymlinkTarget = `${sessionAuthority.sessionsStorePath}.symlink-target`;
await fs.rename(sessionAuthority.sessionsStorePath, storeSymlinkTarget);
await fs.symlink(storeSymlinkTarget, sessionAuthority.sessionsStorePath);
const originalOpenForStoreSymlink = fs.open;
let symlinkStoreOpenFlags;
fs.open = async (target, ...args) => {
  if (String(target) === sessionAuthority.sessionsStorePath) symlinkStoreOpenFlags = args[0];
  return originalOpenForStoreSymlink.call(fs, target, ...args);
};
try {
  await assertUnsafeStoreDidNotBind('symlinked');
} finally {
  fs.open = originalOpenForStoreSymlink;
  await fs.unlink(sessionAuthority.sessionsStorePath);
  await fs.rename(storeSymlinkTarget, sessionAuthority.sessionsStorePath);
}
if (typeof symlinkStoreOpenFlags !== 'number'
    || (symlinkStoreOpenFlags & fsConstants.O_NOFOLLOW) !== fsConstants.O_NOFOLLOW) {
  throw new Error(`sessions store was not opened with O_NOFOLLOW: ${String(symlinkStoreOpenFlags)}`);
}

const originalOpenForOversizedStore = fs.open;
let oversizedStoreReadCount = 0;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForOversizedStore.call(fs, target, ...args);
  if (String(target) === sessionAuthority.sessionsStorePath) {
    const originalHandleRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      oversizedStoreReadCount += 1;
      return originalHandleRead(...readArgs);
    };
  }
  return handle;
};
try {
  await fs.writeFile(
    sessionAuthority.sessionsStorePath,
    Buffer.alloc((8 * 1024 * 1024) + 1, 0x20),
    { mode: 0o600 },
  );
  await assertUnsafeStoreDidNotBind('oversized');
} finally {
  fs.open = originalOpenForOversizedStore;
  await fs.writeFile(sessionAuthority.sessionsStorePath, safeSessionsStoreBytes, { mode: 0o600 });
}
if (oversizedStoreReadCount !== 0) {
  throw new Error(`oversized sessions store was read before the 8 MiB bound rejected it: ${oversizedStoreReadCount}`);
}

const goodHandoff = await fs.readFile(currentPath(goodSessionKey), 'utf8');
if (!goodHandoff.includes('## Native Summary Audit')
    || !goodHandoff.includes('- available: true')
    || !goodHandoff.includes('- ok: true')) {
  throw new Error('good persisted native summary was not audited as available and valid');
}
if (goodHandoff.length > 8000) {
  throw new Error(`native audit pushed handoff beyond 8000 chars: ${goodHandoff.length}`);
}
let index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const goodAudit = parseAuditFromIndex(index, goodSessionKey);
if (goodAudit.available !== true || goodAudit.ok !== true
    || goodAudit.summaryLength !== goodSummary.length
    || goodAudit.reasons?.length) {
  throw new Error(`unexpected good native summary audit: ${JSON.stringify(goodAudit)}`);
}
await handler({
  ...afterEvent(goodSessionKey, goodSessionFile),
  action: 'compact:before',
});
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const auditAfterBeforeSnapshot = parseAuditFromIndex(index, goodSessionKey);
if (JSON.stringify(auditAfterBeforeSnapshot) !== JSON.stringify(goodAudit)) {
  throw new Error('non-after index update erased or changed the latest native summary audit');
}
await handler({
  type: 'message',
  action: 'preprocessed',
  sessionKey: goodSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: {
      sessionId: `${goodSessionKey}-id`,
      sessionFile: goodSessionFile,
      totalTokens: 7000,
      contextTokens: 10000,
    },
  },
});
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const auditAfterEarlySnapshot = parseAuditFromIndex(index, goodSessionKey);
if (JSON.stringify(auditAfterEarlySnapshot) !== JSON.stringify(goodAudit)) {
  throw new Error('early index update erased or changed the latest native summary audit');
}

const boundarySummary = `${goodSummary}\n${'z'.repeat(16000 - goodSummary.length - 1)}`;
const boundarySessionKey = 'agent:main:p1c-audit-boundary-16000';
const boundarySessionFile = path.join(root, 'p1c-audit-boundary-16000.jsonl');
await fs.writeFile(boundarySessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: goodLatestAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Working at ${goodPath}; commit ${goodCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: boundarySummary }),
].join('\n'));
await handler(afterEvent(boundarySessionKey, boundarySessionFile, { summaryLength: boundarySummary.length }));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const boundaryAudit = parseAuditFromIndex(index, boundarySessionKey);
if (boundaryAudit.available !== true || boundaryAudit.ok !== true || boundaryAudit.summaryLength !== 16000) {
  throw new Error(`exact 16000-char native summary did not pass the inclusive cap: ${JSON.stringify(boundaryAudit)}`);
}

const badLatestAsk = 'AUDIT_BAD_LATEST_ASK must survive the native summary';
const badCommit = 'fedcba9876543210fedcba9876543210fedcba98';
const badPath = '/Users/example/project/src/missing-audit-target.ts';
const secretSentinel = `github_pat_${'S'.repeat(48)}`;
const oldGoodSummary = requiredHeadings.map((heading) => `${heading}\n- old valid evidence`).join('\n\n');
const badSummary = `broken suffix without structured body ${secretSentinel} ${'x'.repeat(16020)}`;
const badSessionKey = 'agent:main:p1c-audit-bad';
const badSessionFile = path.join(root, 'p1c-audit-bad.jsonl');
await fs.writeFile(badSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: badLatestAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Use ${badPath} at ${badCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: oldGoodSummary }),
  JSON.stringify({ type: 'compaction', summary: badSummary }),
].join('\n'));
await handler(afterEvent(badSessionKey, badSessionFile, { summaryLength: badSummary.length }));
const badHandoff = await fs.readFile(currentPath(badSessionKey), 'utf8');
if (badHandoff.includes(secretSentinel)) {
  throw new Error('native audit persisted secret-bearing summary content');
}
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const badAudit = parseAuditFromIndex(index, badSessionKey);
const serializedBadIndexSession = JSON.stringify(index.sessions?.[badSessionKey]);
if (serializedBadIndexSession.includes(secretSentinel)
    || serializedBadIndexSession.includes('broken suffix without structured body')) {
  throw new Error('index persisted secret-bearing native summary body content');
}
const expectedBadReasons = [
  'summary-too-long',
  'summary-not-structured',
  ...requiredHeadings.map((heading) => `missing-required-section:${heading.slice(3)}`),
  'latest-user-request-missing',
  'exact-reference-missing',
];
if (badAudit.available !== true || badAudit.ok !== false || badAudit.summaryLength !== badSummary.length) {
  throw new Error(`bad summary availability/length audit is wrong: ${JSON.stringify(badAudit)}`);
}
for (const reason of expectedBadReasons) {
  if (!badAudit.reasons?.includes(reason)) {
    throw new Error(`bad summary audit missing reason ${reason}: ${JSON.stringify(badAudit)}`);
  }
}
await handler({
  type: 'session',
  action: 'compact:before',
  sessionKey: badSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: {
      sessionId: `${badSessionKey}-id`,
      sessionFile: badSessionFile,
    },
  },
});
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const badAuditAfterNonAfterMutation = parseAuditFromIndex(index, badSessionKey);
if (badAuditAfterNonAfterMutation.available !== badAudit.available
    || badAuditAfterNonAfterMutation.ok !== badAudit.ok
    || badAuditAfterNonAfterMutation.summaryLength !== badAudit.summaryLength
    || JSON.stringify(badAuditAfterNonAfterMutation.reasons) !== JSON.stringify(badAudit.reasons)) {
  throw new Error(`non-after index mutation changed over-limit summary audit length: ${JSON.stringify({
    before: badAudit,
    after: badAuditAfterNonAfterMutation,
  })}`);
}

const truncatedRowSessionKey = 'agent:main:p1c-newest-complete-before-truncated';
const truncatedRowSessionFile = path.join(root, 'p1c-newest-complete-before-truncated.jsonl');
await fs.writeFile(truncatedRowSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: goodLatestAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Use ${goodPath} at ${goodCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
  '{"type":"compaction","summary":"TRUNCATED_LATEST_ROW',
].join('\n'));
await handler(afterEvent(truncatedRowSessionKey, truncatedRowSessionFile, { summaryLength: goodSummary.length }));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const truncatedRowAudit = parseAuditFromIndex(index, truncatedRowSessionKey);
if (truncatedRowAudit.available !== true
    || truncatedRowAudit.ok !== true
    || truncatedRowAudit.summaryLength !== goodSummary.length) {
  throw new Error(`truncated trailing JSONL row displaced the newest complete compaction: ${JSON.stringify(truncatedRowAudit)}`);
}

const earlierAsk = 'P1C_EARLIER_REAL_USER_REQUEST';
const actualLatestAsk = 'P1C_ACTUAL_LATEST_REAL_USER_REQUEST';
const earlierOnlySummary = [
  '## Decisions',
  `- Preserve ${goodCommit}.`,
  '',
  '## Open TODOs',
  `- Continue ${earlierAsk}.`,
  '',
  '## Constraints/Rules',
  '- Distinguish the latest real user.',
  '',
  '## Pending user asks',
  `- ${earlierAsk}`,
  '',
  '## Exact identifiers',
  `- ${goodPath}`,
].join('\n');
const earlierOnlySessionKey = 'agent:main:p1c-earlier-user-not-latest';
const earlierOnlySessionFile = path.join(root, 'p1c-earlier-user-not-latest.jsonl');
await fs.writeFile(earlierOnlySessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: earlierAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: actualLatestAsk } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Use ${goodPath} at ${goodCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: earlierOnlySummary }),
].join('\n'));
await handler(afterEvent(earlierOnlySessionKey, earlierOnlySessionFile, { summaryLength: earlierOnlySummary.length }));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const earlierOnlyAudit = parseAuditFromIndex(index, earlierOnlySessionKey);
if (earlierOnlyAudit.ok !== false || !earlierOnlyAudit.reasons.includes('latest-user-request-missing')) {
  throw new Error(`earlier real-user text incorrectly satisfied the latest-user requirement: ${JSON.stringify(earlierOnlyAudit)}`);
}

const provenanceLatestAsk = 'P1C_LATEST_REAL_USER_BEFORE_SYNTHETIC_MESSAGES';
const provenanceSummary = [
  '## Decisions',
  `- Preserve ${goodCommit}.`,
  '',
  '## Open TODOs',
  `- Continue ${provenanceLatestAsk}.`,
  '',
  '## Constraints/Rules',
  '- Ignore later synthetic and tool messages.',
  '',
  '## Pending user asks',
  `- ${provenanceLatestAsk}`,
  '',
  '## Exact identifiers',
  `- ${goodPath}`,
].join('\n');
const provenanceSessionKey = 'agent:main:p1c-latest-real-user-provenance';
const provenanceSessionFile = path.join(root, 'p1c-latest-real-user-provenance.jsonl');
await fs.writeFile(provenanceSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: provenanceLatestAsk } }),
  JSON.stringify({ type: 'message', metadata: { synthetic: true }, message: { role: 'user', content: 'P1C_SYNTHETIC_USER_AFTER_REAL' } }),
  JSON.stringify({ type: 'message', message: { role: 'tool', content: 'P1C_TOOL_AFTER_REAL' } }),
  JSON.stringify({ type: 'message', message: { role: 'system', content: 'P1C_SYSTEM_AFTER_REAL' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Use ${goodPath} at ${goodCommit}.` } }),
  JSON.stringify({ type: 'compaction', summary: provenanceSummary }),
].join('\n'));
await handler(afterEvent(provenanceSessionKey, provenanceSessionFile, { summaryLength: provenanceSummary.length }));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const provenanceAudit = parseAuditFromIndex(index, provenanceSessionKey);
if (provenanceAudit.available !== true || provenanceAudit.ok !== true || provenanceAudit.reasons.length !== 0) {
  throw new Error(`synthetic/tool/system messages displaced the latest real user: ${JSON.stringify(provenanceAudit)}`);
}

const attackerSessionKey = 'agent:main:p1c-cross-session-attacker';
const attackerTranscriptFile = path.join(root, 'p1c-cross-session-attacker.jsonl');
await fs.writeFile(attackerTranscriptFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'Authoritative attacker transcript.' },
}));
const attackerAuthority = await sessionAuthority.registerSessionFixture(
  attackerSessionKey,
  `${attackerSessionKey}-id`,
  attackerTranscriptFile,
);
const victimTranscriptFile = path.join(root, 'p1c-cross-session-victim.jsonl');
const victimTranscriptSecret = 'P1C_CROSS_SESSION_VICTIM_SECRET_MUST_NOT_COPY';
await fs.writeFile(victimTranscriptFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: victimTranscriptSecret },
}));
const forgedAttackerEvent = afterEvent(attackerSessionKey, victimTranscriptFile);
forgedAttackerEvent.context.sessionEntry.sessionId = attackerAuthority.sessionId;
await rawHandler(forgedAttackerEvent);
const attackerHandoff = await fs.readFile(currentPath(attackerSessionKey), 'utf8');
const attackerIndexSession = JSON.stringify(
  (JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'))).sessions?.[attackerSessionKey],
);
if (attackerHandoff.includes(victimTranscriptSecret) || attackerIndexSession.includes(victimTranscriptSecret)) {
  throw new Error('event-provided sessionFile crossed session ownership boundary');
}

const aliasSessionKey = 'agent:main:p1c-non-exact-path-alias';
const aliasSource = path.join(root, 'p1c-non-exact-path-alias.jsonl');
const aliasSentinel = 'P1C_NON_EXACT_PATH_ALIAS_MUST_NOT_BIND';
await fs.writeFile(aliasSource, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: aliasSentinel } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
].join('\n'));
const aliasAuthority = await sessionAuthority.registerSessionFixture(
  aliasSessionKey,
  'p1c-non-exact-path-alias-id',
  aliasSource,
);
const aliasPath = `${path.dirname(aliasAuthority.sessionFile)}${path.sep}.${path.sep}${path.basename(aliasAuthority.sessionFile)}`;
const aliasEvent = afterEvent(aliasSessionKey, aliasSource, { summaryLength: goodSummary.length });
aliasEvent.context.sessionEntry.sessionId = aliasAuthority.sessionId;
aliasEvent.context.sessionEntry.sessionFile = aliasPath;
await rawHandler(aliasEvent);
const aliasHandoff = await fs.readFile(currentPath(aliasSessionKey), 'utf8');
if (aliasHandoff.includes(aliasSentinel)) {
  throw new Error('non-exact alias path was accepted as authoritative transcript binding');
}

const inodeSwapSessionKey = 'agent:main:p1c-transcript-inode-swap';
const inodeSwapSource = path.join(root, 'p1c-transcript-inode-original.jsonl');
await fs.writeFile(inodeSwapSource, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Original inode-bound transcript.' } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
].join('\n'));
const inodeSwapAuthority = await sessionAuthority.registerSessionFixture(
  inodeSwapSessionKey,
  'p1c-transcript-inode-swap-id',
  inodeSwapSource,
);
const inodeSwapReplacement = path.join(sessionAuthority.sessionsDir, 'p1c-transcript-inode-replacement.tmp');
const inodeSwapSecret = 'P1C_TRANSCRIPT_INODE_SWAP_SECRET_MUST_NOT_READ';
await fs.writeFile(inodeSwapReplacement, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: inodeSwapSecret } }),
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
].join('\n'), { mode: 0o600 });
const inodeSwapEvent = afterEvent(inodeSwapSessionKey, inodeSwapSource, { summaryLength: goodSummary.length });
inodeSwapEvent.context.sessionEntry.sessionId = inodeSwapAuthority.sessionId;
delete inodeSwapEvent.context.sessionEntry.sessionFile;
const originalRealpathForInodeSwap = fs.realpath;
const originalWarnForInodeSwap = console.warn;
let inodeSwapPerformed = false;
const inodeSwapWarnings = [];
fs.realpath = async (target, ...args) => {
  const resolved = await originalRealpathForInodeSwap.call(fs, target, ...args);
  if (!inodeSwapPerformed && String(target) === inodeSwapAuthority.sessionFile) {
    await fs.rename(inodeSwapReplacement, inodeSwapAuthority.sessionFile);
    inodeSwapPerformed = true;
  }
  return resolved;
};
console.warn = (...args) => {
  inodeSwapWarnings.push(args.map(String).join(' '));
  originalWarnForInodeSwap(...args);
};
try {
  await rawHandler(inodeSwapEvent);
} finally {
  fs.realpath = originalRealpathForInodeSwap;
  console.warn = originalWarnForInodeSwap;
}
if (!inodeSwapPerformed) {
  throw new Error('transcript inode-swap fixture did not reach the validation/open boundary');
}
const inodeSwapHandoff = await fs.readFile(currentPath(inodeSwapSessionKey), 'utf8');
if (inodeSwapHandoff.includes(inodeSwapSecret)) {
  throw new Error('authoritative transcript validation was not bound to the opened inode');
}
if (!inodeSwapWarnings.some((warning) => warning.includes('could not read bounded session tail (ESTALE)'))) {
  throw new Error(`transcript inode swap did not fail the opened handle with ESTALE: ${JSON.stringify(inodeSwapWarnings)}`);
}

const symlinkTranscriptSessionKey = 'agent:main:p1c-symlink-transcript';
const symlinkTranscriptSource = path.join(root, 'p1c-symlink-transcript-source.jsonl');
await fs.writeFile(symlinkTranscriptSource, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'Original authoritative transcript.' },
}));
const symlinkTranscriptAuthority = await sessionAuthority.registerSessionFixture(
  symlinkTranscriptSessionKey,
  'p1c-symlink-transcript-id',
  symlinkTranscriptSource,
);
await fs.unlink(symlinkTranscriptAuthority.sessionFile);
await fs.symlink(victimTranscriptFile, symlinkTranscriptAuthority.sessionFile);
const symlinkTranscriptEvent = afterEvent(
  symlinkTranscriptSessionKey,
  symlinkTranscriptAuthority.sessionFile,
);
symlinkTranscriptEvent.context.sessionEntry.sessionId = symlinkTranscriptAuthority.sessionId;
await rawHandler(symlinkTranscriptEvent);
if ((await fs.readFile(currentPath(symlinkTranscriptSessionKey), 'utf8')).includes(victimTranscriptSecret)) {
  throw new Error('authoritative transcript resolver followed a symlinked conventional path');
}

const invalidSessionIdKey = 'agent:main:p1c-invalid-session-id';
const invalidStore = JSON.parse(await fs.readFile(sessionAuthority.sessionsStorePath, 'utf8'));
invalidStore[invalidSessionIdKey] = {
  sessionId: '../../p1c-cross-session-victim',
  sessionFile: victimTranscriptFile,
};
await fs.writeFile(sessionAuthority.sessionsStorePath, `${JSON.stringify(invalidStore, null, 2)}\n`);
const invalidSessionIdEvent = afterEvent(invalidSessionIdKey, victimTranscriptFile);
invalidSessionIdEvent.context.sessionEntry.sessionId = '../../p1c-cross-session-victim';
await rawHandler(invalidSessionIdEvent);
if ((await fs.readFile(currentPath(invalidSessionIdKey), 'utf8')).includes(victimTranscriptSecret)) {
  throw new Error('invalid authoritative sessionId escaped the agent sessions directory');
}

const validTopicSessionKey = 'agent:main:discord:channel:topic123';
const validTopicSource = path.join(root, 'p1c-valid-topic.jsonl');
const validTopicSentinel = 'P1C_VALID_TOPIC_CONVENTIONAL_BINDING';
await fs.writeFile(validTopicSource, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: validTopicSentinel },
}));
await handler(afterEvent(validTopicSessionKey, validTopicSource));
if (!(await fs.readFile(currentPath(validTopicSessionKey), 'utf8')).includes(validTopicSentinel)) {
  throw new Error('safe topic identifier did not resolve its conventional transcript');
}

async function assertIdentifierRejected(sessionKey, sessionId, label) {
  const event = afterEvent(sessionKey, victimTranscriptFile);
  event.context.sessionEntry.sessionId = sessionId;
  event.context.sessionEntry.sessionFile = victimTranscriptFile;
  await rawHandler(event);
  if ((await fs.readFile(currentPath(sessionKey), 'utf8')).includes(victimTranscriptSecret)) {
    throw new Error(`${label} identifier selected the victim transcript`);
  }
}

await assertIdentifierRejected('agent:..:p1c-invalid-agent', 'valid-session-id', 'invalid agent');
await assertIdentifierRejected('agent:main:discord:channel:..', 'valid-session-id', 'invalid topic');

const invalidSessionIdMatrix = [
  ['agent:main:p1c-invalid-session-dot', '..'],
  ['agent:main:p1c-invalid-session-slash', 'bad/session'],
  ['agent:main:p1c-invalid-session-space', 'bad session'],
  ['agent:main:p1c-invalid-session-leading', '-leading'],
  ['agent:main:p1c-invalid-session-overlength', 'x'.repeat(181)],
];
const invalidMatrixStore = JSON.parse(await fs.readFile(sessionAuthority.sessionsStorePath, 'utf8'));
for (const [sessionKey, sessionId] of invalidSessionIdMatrix) {
  invalidMatrixStore[sessionKey] = { sessionId };
}
await fs.writeFile(sessionAuthority.sessionsStorePath, `${JSON.stringify(invalidMatrixStore, null, 2)}\n`, { mode: 0o600 });
for (const [sessionKey, sessionId] of invalidSessionIdMatrix) {
  await assertIdentifierRejected(sessionKey, sessionId, `invalid sessionId ${JSON.stringify(sessionId)}`);
}

const missingSessionKey = 'agent:main:p1c-audit-missing';
const missingSessionFile = path.join(root, 'p1c-audit-missing.jsonl');
await fs.writeFile(missingSessionFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'No compaction row exists yet.' },
}));
await handler(afterEvent(missingSessionKey, missingSessionFile));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const missingAudit = parseAuditFromIndex(index, missingSessionKey);
if (missingAudit.available !== false
    || !missingAudit.reasons?.includes('compaction-entry-not-found-in-bounded-tail')
    || 'ok' in missingAudit
    || 'summaryLength' in missingAudit) {
  throw new Error(`missing compaction audit falsely claimed verification: ${JSON.stringify(missingAudit)}`);
}

const unavailableSummarySessionKey = 'agent:main:p1c-audit-unavailable-summary';
const unavailableSummaryFile = path.join(root, 'p1c-audit-unavailable-summary.jsonl');
await fs.writeFile(unavailableSummaryFile, [
  JSON.stringify({ type: 'compaction', summary: goodSummary }),
  JSON.stringify({ type: 'compaction', summary: 42 }),
].join('\n'));
await handler(afterEvent(unavailableSummarySessionKey, unavailableSummaryFile));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const unavailableSummaryAudit = parseAuditFromIndex(index, unavailableSummarySessionKey);
if (unavailableSummaryAudit.available !== false
    || !unavailableSummaryAudit.reasons?.includes('latest-compaction-summary-unavailable')) {
  throw new Error(`newest unusable compaction row fell back to an older summary: ${JSON.stringify(unavailableSummaryAudit)}`);
}

const tailReadFailureSessionKey = 'agent:main:p1c-audit-tail-read-failure';
const tailReadFailureFile = path.join(root, 'p1c-audit-tail-read-failure.jsonl');
const tailReadFailureCanonicalFile = sessionAuthority.canonicalSessionPath(
  tailReadFailureSessionKey,
  `${tailReadFailureSessionKey}-id`,
);
await fs.writeFile(tailReadFailureFile, JSON.stringify({ type: 'compaction', summary: goodSummary }));
const originalOpen = fs.open;
fs.open = async (target, ...args) => {
  if (String(target) === tailReadFailureCanonicalFile) {
    throw Object.assign(new Error('injected bounded tail read EIO'), { code: 'EIO' });
  }
  return originalOpen.call(fs, target, ...args);
};
try {
  await handler(afterEvent(tailReadFailureSessionKey, tailReadFailureFile));
} finally {
  fs.open = originalOpen;
}
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const tailReadFailureAudit = parseAuditFromIndex(index, tailReadFailureSessionKey);
if (tailReadFailureAudit.available !== false
    || !tailReadFailureAudit.reasons?.includes('session-tail-read-failed')
    || 'ok' in tailReadFailureAudit) {
  throw new Error(`bounded tail I/O failure falsely claimed native-summary verification: ${JSON.stringify(tailReadFailureAudit)}`);
}

const authorizationSessionKey = 'agent:main:p1c-authorization-schemes';
const authorizationSessionFile = path.join(root, 'p1c-authorization-schemes.jsonl');
const basicCredential = 'dXNlcjpwYXNz';
const digestCredential = 'response="abcdef0123456789"';
await fs.writeFile(authorizationSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: `Authorization: Basic ${basicCredential}` } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `Proxy-Authorization: Digest username="admin", ${digestCredential}` } }),
].join('\n'));
await handler(afterEvent(authorizationSessionKey, authorizationSessionFile));
const authorizationHandoff = await fs.readFile(currentPath(authorizationSessionKey), 'utf8');
if (authorizationHandoff.includes(basicCredential)
    || authorizationHandoff.includes(digestCredential)
    || !authorizationHandoff.includes('Authorization: [REDACTED]')
    || !authorizationHandoff.includes('Proxy-Authorization: [REDACTED]')) {
  throw new Error('non-Bearer Authorization credential survived persisted handoff redaction');
}

const structuredAuthorizationSessionKey = 'agent:main:p1c-structured-authorization';
const structuredAuthorizationSessionFile = path.join(root, 'p1c-structured-authorization.jsonl');
const quotedJsonBasicCredential = 'cXVvdGVkLXVzZXI6c2VjcmV0';
const quotedJsonDigestCredential = '0123456789abcdef';
const assignedBasicCredential = 'shortOpaqueCredential42';
const assignedProxyCredential = 'proxyOpaqueCredential24';
await fs.writeFile(structuredAuthorizationSessionFile, [
  JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: JSON.stringify({ Authorization: `Basic ${quotedJsonBasicCredential}` }),
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: JSON.stringify({
        'Proxy-Authorization': `Digest response=\"${quotedJsonDigestCredential}\"`,
      }),
    },
  }),
  JSON.stringify({
    type: 'message',
    message: { role: 'user', content: `Authorization = \"Basic ${assignedBasicCredential}\"` },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: `'Proxy-Authorization' = 'Digest response=\"${assignedProxyCredential}\"'`,
    },
  }),
].join('\n'));
await handler(afterEvent(structuredAuthorizationSessionKey, structuredAuthorizationSessionFile));
const structuredAuthorizationHandoff = await fs.readFile(
  currentPath(structuredAuthorizationSessionKey),
  'utf8',
);
const structuredAuthorizationSecrets = [
  quotedJsonBasicCredential,
  quotedJsonDigestCredential,
  assignedBasicCredential,
  assignedProxyCredential,
];
if (structuredAuthorizationSecrets.some((credential) => structuredAuthorizationHandoff.includes(credential))) {
  throw new Error('quoted or assigned Authorization credential survived persisted handoff redaction');
}

const continuedAuthorizationSessionKey = 'agent:main:p1c-continued-authorization';
const continuedAuthorizationSessionFile = path.join(root, 'p1c-continued-authorization.jsonl');
const foldedAuthorizationCredential = 'dXNlcjpwYXNz';
const shellWrappedAuthorizationCredential = 'shellWrappedOpaque42';
const foldedAuthorizationValue = `Authorization: Basic\r\n ${foldedAuthorizationCredential}`;
const shellWrappedAuthorizationValue = [
  'curl -H "Authorization: Bearer \\',
  `${shellWrappedAuthorizationCredential}" https://example.invalid`,
].join('\n');
const shellAuthorizationNewline = shellWrappedAuthorizationValue.indexOf('\n');
if (shellAuthorizationNewline < 1
    || shellWrappedAuthorizationValue[shellAuthorizationNewline - 1] !== '\\'
    || !shellWrappedAuthorizationValue.slice(shellAuthorizationNewline + 1)
      .startsWith(shellWrappedAuthorizationCredential)) {
  throw new Error('shell-wrapped Authorization fixture did not contain backslash-LF credential continuation');
}
await fs.writeFile(continuedAuthorizationSessionFile, [
  JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: foldedAuthorizationValue,
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: shellWrappedAuthorizationValue,
    },
  }),
].join('\n'));
await handler(afterEvent(continuedAuthorizationSessionKey, continuedAuthorizationSessionFile));
const continuedAuthorizationHandoff = await fs.readFile(
  currentPath(continuedAuthorizationSessionKey),
  'utf8',
);
if (continuedAuthorizationHandoff.includes(foldedAuthorizationCredential)
    || continuedAuthorizationHandoff.includes(shellWrappedAuthorizationCredential)) {
  throw new Error('continued or shell-wrapped Authorization credential survived persisted handoff redaction');
}

const structuredCookieSessionKey = 'agent:main:p1c-structured-cookie';
const structuredCookieSessionFile = path.join(root, 'p1c-structured-cookie.jsonl');
const quotedJsonCookieCredential = 'quotedCookieOpaque31';
const quotedSetCookieCredential = 'quotedSetCookieOpaque32';
const assignedCookieCredential = 'assignedCookieOpaque33';
await fs.writeFile(structuredCookieSessionFile, [
  JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: JSON.stringify({ Cookie: `sid=${quotedJsonCookieCredential}` }),
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: `'Set-Cookie': 'sid=${quotedSetCookieCredential}; Path=/'`,
    },
  }),
  JSON.stringify({
    type: 'message',
    message: {
      role: 'user',
      content: `\"Cookie\" = \"sid=${assignedCookieCredential}\"`,
    },
  }),
].join('\n'));
await handler(afterEvent(structuredCookieSessionKey, structuredCookieSessionFile));
const structuredCookieHandoff = await fs.readFile(currentPath(structuredCookieSessionKey), 'utf8');
const structuredCookieSecrets = [
  quotedJsonCookieCredential,
  quotedSetCookieCredential,
  assignedCookieCredential,
];
if (structuredCookieSecrets.some((credential) => structuredCookieHandoff.includes(credential))) {
  throw new Error('quoted or assigned Cookie credential survived persisted handoff redaction');
}

const shellAdjacentHeaderSessionKey = 'agent:main:p1c-shell-adjacent-headers';
const shellAdjacentHeaderSessionFile = path.join(root, 'p1c-shell-adjacent-headers.jsonl');
const quotedConcatAuthorizationCredential = 'quotedConcatOpaque34';
const unquotedContinuedAuthorizationCredential = 'unquotedContinuedOpaque35';
const adjacentCookieCredential = 'adjacentCookieOpaque36';
const continuedSetCookieCredential = 'continuedSetCookieOpaque37';
const quotedConcatAuthorizationValue = [
  'curl -H "Authorization: Bearer "\\',
  `${quotedConcatAuthorizationCredential} https://example.invalid`,
].join('\n');
const unquotedContinuedAuthorizationValue = [
  'curl -H Authorization:\\ Bearer\\ \\',
  `${unquotedContinuedAuthorizationCredential} https://example.invalid`,
].join('\n');
const adjacentCookieValue = `"Cookie: sid="${adjacentCookieCredential}`;
const continuedSetCookieValue = [
  "curl -H 'Set-Cookie: sid='\\",
  `${continuedSetCookieCredential} https://example.invalid`,
].join('\n');
for (const [value, credential] of [
  [quotedConcatAuthorizationValue, quotedConcatAuthorizationCredential],
  [unquotedContinuedAuthorizationValue, unquotedContinuedAuthorizationCredential],
  [continuedSetCookieValue, continuedSetCookieCredential],
]) {
  const newlineIndex = value.indexOf('\n');
  if (newlineIndex < 1
      || value[newlineIndex - 1] !== '\\'
      || !value.slice(newlineIndex + 1).startsWith(credential)) {
    throw new Error('shell-adjacent header fixture did not contain backslash-LF credential continuation');
  }
}
if (!adjacentCookieValue.includes(`"${adjacentCookieCredential}`)) {
  throw new Error('shell-adjacent Cookie fixture did not contain quoted-segment concatenation');
}
await fs.writeFile(shellAdjacentHeaderSessionFile, [
  quotedConcatAuthorizationValue,
  unquotedContinuedAuthorizationValue,
  adjacentCookieValue,
  continuedSetCookieValue,
].map((content, index) => JSON.stringify({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
})).join('\n'));
await handler(afterEvent(shellAdjacentHeaderSessionKey, shellAdjacentHeaderSessionFile));
const shellAdjacentHeaderHandoff = await fs.readFile(
  currentPath(shellAdjacentHeaderSessionKey),
  'utf8',
);
const shellAdjacentHeaderSecrets = [
  quotedConcatAuthorizationCredential,
  unquotedContinuedAuthorizationCredential,
  adjacentCookieCredential,
  continuedSetCookieCredential,
];
if (shellAdjacentHeaderSecrets.some((credential) => shellAdjacentHeaderHandoff.includes(credential))) {
  throw new Error('shell-adjacent or unquoted-continued header credential survived persisted handoff redaction');
}

const quotedFoldHeaderSessionKey = 'agent:main:p1c-quoted-fold-headers';
const quotedFoldHeaderSessionFile = path.join(root, 'p1c-quoted-fold-headers.jsonl');
const quotedFoldAuthorizationCredential = 'quotedFoldAuthOpaque38';
const punctuationFoldProxyCredential = 'punctuationFoldProxyOpaque39';
const evenBackslashFoldCookieCredential = 'evenBackslashFoldCookieOpaque40';
const multipleFoldSetCookieCredentialA = 'multipleFoldSetCookieOpaque41A';
const multipleFoldSetCookieCredentialB = 'multipleFoldSetCookieOpaque41B';
const quotedFoldAuthorizationValue = `Authorization: "Basic decoy";\r\n\t${quotedFoldAuthorizationCredential}`;
const punctuationFoldProxyValue = `Proxy-Authorization: "Digest decoy"!\n ${punctuationFoldProxyCredential}`;
const evenBackslashFoldCookieValue = `Cookie: "sid=decoy"\\\\\r\n\t${evenBackslashFoldCookieCredential}`;
const multipleFoldSetCookieValue = `Set-Cookie: "sid=decoy";\r\n\t${multipleFoldSetCookieCredentialA}\n ${multipleFoldSetCookieCredentialB}`;
if (!quotedFoldAuthorizationValue.includes(`\r\n\t${quotedFoldAuthorizationCredential}`)
    || !punctuationFoldProxyValue.includes(`\n ${punctuationFoldProxyCredential}`)
    || !multipleFoldSetCookieValue.includes(`\r\n\t${multipleFoldSetCookieCredentialA}\n ${multipleFoldSetCookieCredentialB}`)) {
  throw new Error('quoted-fold header fixture did not contain the required LF/CRLF continuations');
}
const evenFoldNewline = evenBackslashFoldCookieValue.indexOf('\r\n');
let evenFoldBackslashes = 0;
for (let index = evenFoldNewline - 1; index >= 0 && evenBackslashFoldCookieValue[index] === '\\'; index -= 1) {
  evenFoldBackslashes += 1;
}
if (evenFoldNewline < 0
    || evenFoldBackslashes !== 2
    || !evenBackslashFoldCookieValue.slice(evenFoldNewline + 2)
      .startsWith(`\t${evenBackslashFoldCookieCredential}`)) {
  throw new Error('even-backslash folded Cookie fixture did not preserve two backslashes before CRLF-tab');
}
await fs.writeFile(quotedFoldHeaderSessionFile, [
  quotedFoldAuthorizationValue,
  punctuationFoldProxyValue,
  evenBackslashFoldCookieValue,
  multipleFoldSetCookieValue,
].map((content, index) => JSON.stringify({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
})).join('\n'));
await handler(afterEvent(quotedFoldHeaderSessionKey, quotedFoldHeaderSessionFile));
const quotedFoldHeaderHandoff = await fs.readFile(currentPath(quotedFoldHeaderSessionKey), 'utf8');
const quotedFoldHeaderSecrets = [
  quotedFoldAuthorizationCredential,
  punctuationFoldProxyCredential,
  evenBackslashFoldCookieCredential,
  multipleFoldSetCookieCredentialA,
  multipleFoldSetCookieCredentialB,
];
if (quotedFoldHeaderSecrets.some((credential) => quotedFoldHeaderHandoff.includes(credential))) {
  throw new Error('quoted or shell-adjacent folded header credential survived persisted handoff redaction');
}

const structuredDelimiterSessionKey = 'agent:main:p1c-structured-header-delimiter';
const structuredDelimiterSessionFile = path.join(root, 'p1c-structured-header-delimiter.jsonl');
const structuredDelimiterCredential = 'jsonDelimiterOpaque42';
const structuredDelimiterSafePath = '/tmp/structured-json-delimiter-keep';
const structuredDelimiterValue = JSON.stringify({
  Authorization: `Basic ${structuredDelimiterCredential}`,
  safePath: structuredDelimiterSafePath,
});
if (!structuredDelimiterValue.includes(`,"safePath":"${structuredDelimiterSafePath}"`)) {
  throw new Error('structured delimiter fixture was not compact JSON with an adjacent safe field');
}
await fs.writeFile(structuredDelimiterSessionFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: structuredDelimiterValue },
}));
await handler(afterEvent(structuredDelimiterSessionKey, structuredDelimiterSessionFile));
const structuredDelimiterHandoff = await fs.readFile(currentPath(structuredDelimiterSessionKey), 'utf8');
if (structuredDelimiterHandoff.includes(structuredDelimiterCredential)) {
  throw new Error('structured JSON Authorization credential survived persisted handoff redaction');
}
if (!structuredDelimiterHandoff.includes(structuredDelimiterSafePath)
    || !structuredDelimiterHandoff.includes(`,"safePath":"${structuredDelimiterSafePath}"`)) {
  throw new Error('structured JSON delimiter or safe field was over-redacted');
}

const dynamicShellHeaderSessionKey = 'agent:main:p1c-dynamic-shell-headers';
const dynamicShellHeaderSessionFile = path.join(root, 'p1c-dynamic-shell-headers.jsonl');
const commandAuthorizationCredential = 'commandAuthOpaque43';
const commandCookieCredential = 'commandCookieOpaque44';
const backtickProxyCredential = 'backtickProxyOpaque45';
const nestedExpansionSetCookieCredential = 'nestedSetCookieOpaque46';
const dynamicShellHeaderValues = [
  `curl -H "Authorization: Basic "$(printf ${commandAuthorizationCredential})`,
  `curl -H "Cookie: sid="$(printf ${commandCookieCredential})`,
  `curl -H "Proxy-Authorization: Digest "\`printf ${backtickProxyCredential}\``,
  `curl -H "Set-Cookie: sid="\${UNSET_VALUE:-$(printf ${nestedExpansionSetCookieCredential})}`,
];
const dynamicShellHeaderSecrets = [
  commandAuthorizationCredential,
  commandCookieCredential,
  backtickProxyCredential,
  nestedExpansionSetCookieCredential,
];
for (const [index, credential] of dynamicShellHeaderSecrets.entries()) {
  if (!dynamicShellHeaderValues[index].includes(`printf ${credential}`)) {
    throw new Error('dynamic shell header fixture did not contain a spaced command substitution');
  }
}
await fs.writeFile(dynamicShellHeaderSessionFile, dynamicShellHeaderValues.map((content, index) => JSON.stringify({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
})).join('\n'));
await handler(afterEvent(dynamicShellHeaderSessionKey, dynamicShellHeaderSessionFile));
const dynamicShellHeaderHandoff = await fs.readFile(currentPath(dynamicShellHeaderSessionKey), 'utf8');
if (dynamicShellHeaderSecrets.some((credential) => dynamicShellHeaderHandoff.includes(credential))) {
  throw new Error('dynamic shell header command credential survived persisted handoff redaction');
}

const enclosingDynamicSessionKey = 'agent:main:p1c-enclosing-quote-dynamic-shell';
const enclosingDynamicSessionFile = path.join(root, 'p1c-enclosing-quote-dynamic-shell.jsonl');
const enclosingCommandAuthCredential = 'enclosingCommandAuthOpaque61';
const enclosingParameterCookieCredential = 'enclosingParameterCookieOpaque62';
const enclosingBacktickProxyCredential = 'enclosingBacktickProxyOpaque63';
const enclosingInputProcessCookieCredential = 'enclosingInputProcessCookieOpaque64';
const enclosingOutputProcessAuthCredential = 'enclosingOutputProcessAuthOpaque65';
const enclosingDynamicValues = [
  `curl -H "Authorization: Bearer $(printf "%s" " ${enclosingCommandAuthCredential}")"`,
  `curl -H "Cookie: sid=\${UNSET:-$(printf "%s" " ${enclosingParameterCookieCredential}")}"`,
  `curl -H "Proxy-Authorization: Digest \`printf "%s" " ${enclosingBacktickProxyCredential}"\`"`,
  `curl -H "Set-Cookie: sid=<(printf "%s" " ${enclosingInputProcessCookieCredential}")"`,
  `curl -H "Authorization: Bearer >(printf "%s" " ${enclosingOutputProcessAuthCredential}")"`,
];
const enclosingDynamicSecrets = [
  enclosingCommandAuthCredential,
  enclosingParameterCookieCredential,
  enclosingBacktickProxyCredential,
  enclosingInputProcessCookieCredential,
  enclosingOutputProcessAuthCredential,
];
const enclosingDynamicMarkers = ['$(', '${', '`', '<(', '>('];
for (const [index, credential] of enclosingDynamicSecrets.entries()) {
  if (!enclosingDynamicValues[index].includes(enclosingDynamicMarkers[index])
      || !enclosingDynamicValues[index].includes(`" ${credential}`)) {
    throw new Error('enclosing-quote dynamic shell fixture lost nested quote or expansion syntax');
  }
}
await fs.writeFile(enclosingDynamicSessionFile, enclosingDynamicValues.map((content, index) => JSON.stringify({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
})).join('\n'));
await handler(afterEvent(enclosingDynamicSessionKey, enclosingDynamicSessionFile));
const enclosingDynamicHandoff = await fs.readFile(currentPath(enclosingDynamicSessionKey), 'utf8');
if (enclosingDynamicSecrets.some((credential) => enclosingDynamicHandoff.includes(credential))) {
  throw new Error('enclosing-quote dynamic shell credential survived persisted handoff redaction');
}

const adjacentQuotedDynamicSessionKey = 'agent:main:p1c-adjacent-quoted-dynamic-shell';
const adjacentQuotedDynamicSessionFile = path.join(root, 'p1c-adjacent-quoted-dynamic-shell.jsonl');
const adjacentCommandAuthCredential = 'adjacentCommandAuthOpaque68';
const adjacentParameterCookieCredential = 'adjacentParameterCookieOpaque69';
const adjacentBacktickProxyCredential = 'adjacentBacktickProxyOpaque70';
const adjacentInputProcessCookieCredential = 'adjacentInputProcessCookieOpaque71';
const adjacentOutputProcessAuthCredential = 'adjacentOutputProcessAuthOpaque72';
const adjacentQuotedDynamicValues = [
  `curl -H "Authorization: Bearer ""$(printf "%s" " ${adjacentCommandAuthCredential}")"`,
  `curl -H "Cookie: sid=""\${UNSET:-$(printf "%s" " ${adjacentParameterCookieCredential}")}"`,
  `curl -H "Proxy-Authorization: Digest ""\`printf "%s" " ${adjacentBacktickProxyCredential}"\`"`,
  `curl -H "Set-Cookie: sid=""<(printf "%s" " ${adjacentInputProcessCookieCredential}")"`,
  `curl -H "Authorization: Bearer "">(printf "%s" " ${adjacentOutputProcessAuthCredential}")"`,
];
const adjacentQuotedDynamicSecrets = [
  adjacentCommandAuthCredential,
  adjacentParameterCookieCredential,
  adjacentBacktickProxyCredential,
  adjacentInputProcessCookieCredential,
  adjacentOutputProcessAuthCredential,
];
for (const [index, credential] of adjacentQuotedDynamicSecrets.entries()) {
  if (!adjacentQuotedDynamicValues[index].includes('""')
      || !adjacentQuotedDynamicValues[index].includes(`" ${credential}`)) {
    throw new Error('adjacent quoted dynamic shell fixture lost quote adjacency or nested argument');
  }
}
await fs.writeFile(adjacentQuotedDynamicSessionFile, adjacentQuotedDynamicValues
  .map((content, index) => JSON.stringify({
    type: 'message',
    message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
  }))
  .join('\n'));
await handler(afterEvent(adjacentQuotedDynamicSessionKey, adjacentQuotedDynamicSessionFile));
const adjacentQuotedDynamicHandoff = await fs.readFile(currentPath(adjacentQuotedDynamicSessionKey), 'utf8');
if (adjacentQuotedDynamicSecrets.some((credential) => adjacentQuotedDynamicHandoff.includes(credential))) {
  throw new Error('adjacent quoted dynamic shell credential survived persisted handoff redaction');
}

const splicedDynamicSessionKey = 'agent:main:p1c-spliced-dynamic-shell';
const splicedDynamicSessionFile = path.join(root, 'p1c-spliced-dynamic-shell.jsonl');
const spliceCommandAuthCredential = 'spliceCommandAuthOpaque74';
const spliceParameterCookieCredential = 'spliceParameterCookieOpaque75';
const spliceInputProcessCookieCredential = 'spliceInputProcessCookieOpaque76';
const spliceOutputProcessAuthCredential = 'spliceOutputProcessAuthOpaque77';
const lfSplice = '\\' + '\n';
const crlfSplice = '\\' + '\r\n';
const splicedDynamicValues = [
  `curl -H "Authorization: $${lfSplice}(printf " %s" " ${spliceCommandAuthCredential}")"`,
  `curl -H "Cookie: sid=$${crlfSplice}{UNSET:-" ${spliceParameterCookieCredential}"}"`,
  `curl -H "Set-Cookie: sid=<${lfSplice}${crlfSplice}(printf " %s" " ${spliceInputProcessCookieCredential}")"`,
  `curl -H "Proxy-Authorization: Digest >${crlfSplice}(printf " %s" " ${spliceOutputProcessAuthCredential}")"`,
];
const splicedDynamicMarkers = ['$(', '${', '<(', '>('];
const splicedDynamicSecrets = [
  spliceCommandAuthCredential,
  spliceParameterCookieCredential,
  spliceInputProcessCookieCredential,
  spliceOutputProcessAuthCredential,
];
for (const [index, credential] of splicedDynamicSecrets.entries()) {
  const shellSpliced = splicedDynamicValues[index].replace(/\\(?:\r\n|\n)/g, '');
  if (!/\\(?:\r\n|\n)/.test(splicedDynamicValues[index])
      || !shellSpliced.includes(splicedDynamicMarkers[index])
      || !shellSpliced.includes(`" ${credential}`)) {
    throw new Error('spliced dynamic shell fixture lost continuation, expansion, or nested quote');
  }
}
await fs.writeFile(splicedDynamicSessionFile, splicedDynamicValues
  .map((content, index) => JSON.stringify({
    type: 'message',
    message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
  }))
  .join('\n'));
await handler(afterEvent(splicedDynamicSessionKey, splicedDynamicSessionFile));
const splicedDynamicHandoff = await fs.readFile(currentPath(splicedDynamicSessionKey), 'utf8');
if (splicedDynamicSecrets.some((credential) => splicedDynamicHandoff.includes(credential))) {
  throw new Error('line-spliced dynamic shell credential survived persisted handoff redaction');
}

const splicedHeaderKeySessionKey = 'agent:main:p1c-spliced-header-key';
const splicedHeaderKeySessionFile = path.join(root, 'p1c-spliced-header-key.jsonl');
const splicedAuthorizationKeyCredential = 'splicedAuthorizationKeyOpaque78';
const splicedProxyKeyCredential = 'splicedProxyKeyOpaque79';
const splicedCookieKeyCredential = 'splicedCookieKeyOpaque80';
const splicedSetCookieKeyCredential = 'splicedSetCookieKeyOpaque81';
const splicedHeaderKeyValues = [
  `curl -H "Authoriza${lfSplice}tion: Basic ${splicedAuthorizationKeyCredential}"`,
  `curl -H "Proxy-${crlfSplice}Authorization: Digest ${splicedProxyKeyCredential}"`,
  `curl -H "Coo${lfSplice}kie: sid=${splicedCookieKeyCredential}"`,
  `curl -H "Set-${crlfSplice}Cookie${lfSplice}: sid=${splicedSetCookieKeyCredential}"`,
];
const splicedHeaderKeySecrets = [
  splicedAuthorizationKeyCredential,
  splicedProxyKeyCredential,
  splicedCookieKeyCredential,
  splicedSetCookieKeyCredential,
];
for (const [index, credential] of splicedHeaderKeySecrets.entries()) {
  const shellSpliced = splicedHeaderKeyValues[index].replace(/\\(?:\r\n|\n)/g, '');
  if (!/\\(?:\r\n|\n)/.test(splicedHeaderKeyValues[index])
      || !new RegExp(`(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie):[^\\n]*${credential}`, 'i').test(shellSpliced)) {
    throw new Error('spliced credential header-key fixture lost continuation or decoded assignment');
  }
}
await fs.writeFile(splicedHeaderKeySessionFile, splicedHeaderKeyValues
  .map((content, index) => JSON.stringify({
    type: 'message',
    message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
  }))
  .join('\n'));
await handler(afterEvent(splicedHeaderKeySessionKey, splicedHeaderKeySessionFile));
const splicedHeaderKeyHandoff = await fs.readFile(currentPath(splicedHeaderKeySessionKey), 'utf8');
if (splicedHeaderKeySecrets.some((credential) => splicedHeaderKeyHandoff.includes(credential))) {
  throw new Error('line-spliced credential header key survived persisted handoff redaction');
}

const redactionHandlerSource = await fs.readFile(
  new URL('../hooks/compact-handoff/handler.ts', import.meta.url),
  'utf8',
);
const spliceAssignmentHelperStart = redactionHandlerSource.indexOf(
  'function hasShellSplicedCredentialAssignment',
);
const spliceAssignmentHelperEnd = redactionHandlerSource.indexOf(
  'function redactHeaderText',
  spliceAssignmentHelperStart,
);
const spliceAssignmentHelperSource = redactionHandlerSource.slice(
  spliceAssignmentHelperStart,
  spliceAssignmentHelperEnd,
);
if (spliceAssignmentHelperStart < 0
    || spliceAssignmentHelperEnd < 0
    || !spliceAssignmentHelperSource.includes('lastSpliceOffset')
    || spliceAssignmentHelperSource.includes('spliceOffsets')
    || spliceAssignmentHelperSource.includes('.some(')) {
  throw new Error('shell-splice assignment scan retained multiplicative offset search');
}

const spliceQuoteParitySessionKey = 'agent:main:p1c-splice-quote-parity';
const spliceQuoteParitySessionFile = path.join(root, 'p1c-splice-quote-parity.jsonl');
const spliceQuoteAuthorizationCredential = 'spliceQuoteAuthorizationOpaque82';
const spliceQuoteProxyCredential = 'spliceQuoteProxyOpaque83';
const spliceQuoteCookieCredential = 'spliceQuoteCookieOpaque84';
const spliceQuoteSetCookieCredential = 'spliceQuoteSetCookieOpaque85';
const doubleLfSplice = '\\\\' + '\n';
const doubleCrlfSplice = '\\\\' + '\r\n';
const spliceQuoteParityValues = [
  `curl -H "Authorization: Opaque decoy${doubleLfSplice}" ${spliceQuoteAuthorizationCredential}"`,
  `curl -H "Proxy-Authorization: Digest decoy${doubleCrlfSplice}" ${spliceQuoteProxyCredential}"`,
  `curl -H "Cookie: sid=decoy${doubleLfSplice}" ${spliceQuoteCookieCredential}"`,
  `curl -H "Set-Cookie: sid=decoy${doubleCrlfSplice}" ${spliceQuoteSetCookieCredential}"`,
];
const spliceQuoteParitySecrets = [
  spliceQuoteAuthorizationCredential,
  spliceQuoteProxyCredential,
  spliceQuoteCookieCredential,
  spliceQuoteSetCookieCredential,
];
for (const [index, credential] of spliceQuoteParitySecrets.entries()) {
  const shellSpliced = spliceQuoteParityValues[index].replace(/\\(?:\r\n|\n)/g, '');
  if (!/\\(?:\r\n|\n)/.test(spliceQuoteParityValues[index])
      || !shellSpliced.includes(`\\" ${credential}"`)) {
    throw new Error('splice quote-parity fixture lost residual escape or credential membership');
  }
}
await fs.writeFile(spliceQuoteParitySessionFile, spliceQuoteParityValues
  .map((content, index) => JSON.stringify({
    type: 'message',
    message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
  }))
  .join('\n'));
await handler(afterEvent(spliceQuoteParitySessionKey, spliceQuoteParitySessionFile));
const spliceQuoteParityHandoff = await fs.readFile(currentPath(spliceQuoteParitySessionKey), 'utf8');
if (spliceQuoteParitySecrets.some((credential) => spliceQuoteParityHandoff.includes(credential))) {
  throw new Error('line-splice quote-parity credential survived persisted handoff redaction');
}

const spliceStressSessionKey = 'agent:main:p1c-splice-linear-stress';
const spliceStressSessionFile = path.join(root, 'p1c-splice-linear-stress.jsonl');
const spliceStressSentinel = 'spliceLinearStressOpaque86';
const spliceStressContent = 'Authorization:x '.repeat(40_000)
  + lfSplice.repeat(300_000)
  + spliceStressSentinel;
const spliceStressLine = JSON.stringify({
  type: 'message',
  message: { role: 'user', content: spliceStressContent },
});
const spliceStressBytes = Buffer.byteLength(spliceStressLine);
if (spliceStressBytes < 1_500_000 || spliceStressBytes >= 2 * 1024 * 1024) {
  throw new Error('shell-splice linear stress fixture left the bounded near-2-MiB range');
}
await fs.writeFile(spliceStressSessionFile, spliceStressLine);
const spliceStressStartedAt = Date.now();
await handler(afterEvent(spliceStressSessionKey, spliceStressSessionFile));
const spliceStressElapsedMs = Date.now() - spliceStressStartedAt;
const spliceStressHandoff = await fs.readFile(currentPath(spliceStressSessionKey), 'utf8');
if (spliceStressElapsedMs >= 10_000
    || spliceStressHandoff.includes(spliceStressSentinel)
    || !spliceStressHandoff.includes('[REDACTED_SHELL_SPLICED_HEADER]')) {
  throw new Error('shell-splice assignment stress was non-linear or failed closed incorrectly');
}

const preHeaderSpliceFunctionalSessionKey = 'agent:main:p1c-pre-header-splice-redaction';
const preHeaderSpliceFunctionalSessionFile = path.join(root, 'p1c-pre-header-splice-redaction.jsonl');
const preHeaderSpliceFunctionalSentinel = 'preHeaderSpliceRedactionOpaque87';
const preHeaderSpliceFunctionalContent = lfSplice.repeat(3)
  + `safe-gap Authorization:${preHeaderSpliceFunctionalSentinel}`;
await fs.writeFile(preHeaderSpliceFunctionalSessionFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: preHeaderSpliceFunctionalContent },
}));
await handler(afterEvent(
  preHeaderSpliceFunctionalSessionKey,
  preHeaderSpliceFunctionalSessionFile,
));
const preHeaderSpliceFunctionalHandoff = await fs.readFile(
  currentPath(preHeaderSpliceFunctionalSessionKey),
  'utf8',
);
if (preHeaderSpliceFunctionalHandoff.includes(preHeaderSpliceFunctionalSentinel)
    || !preHeaderSpliceFunctionalHandoff.includes('[REDACTED]')) {
  throw new Error('pre-header shell-splice functional credential was not redacted');
}

const preHeaderSpliceStressSessionKey = 'agent:main:p1c-pre-header-splice-linear-stress';
const preHeaderSpliceStressSessionFile = path.join(root, 'p1c-pre-header-splice-linear-stress.jsonl');
const preHeaderSpliceStressSentinel = 'preHeaderSpliceLinearStressOpaque88';
const preHeaderSpliceStressHead = 'pre-header-linear-stress-head';
const preHeaderSpliceStressContent = preHeaderSpliceStressHead
  + lfSplice.repeat(300_000)
  + 'safe-prefix '
  + 'Authorization:x '.repeat(40_000)
  + `Authorization:${preHeaderSpliceStressSentinel}`;
let preHeaderStressRemovedLength = 0;
let preHeaderStressLastSpliceOffset = -1;
const normalizedPreHeaderSpliceStress = preHeaderSpliceStressContent.replace(
  /\\(?:\r\n|\n)/g,
  (splice, offset) => {
    preHeaderStressLastSpliceOffset = offset - preHeaderStressRemovedLength;
    preHeaderStressRemovedLength += splice.length;
    return '';
  },
);
const preHeaderStressFirstAssignmentOffset = normalizedPreHeaderSpliceStress.indexOf(
  'Authorization:x ',
);
const priorSpanSearchComparisonFloor = 40_001n * 300_000n;
if (preHeaderStressLastSpliceOffset < 0
    || preHeaderStressFirstAssignmentOffset <= preHeaderStressLastSpliceOffset
    || priorSpanSearchComparisonFloor <= 10_000_000_000n) {
  throw new Error('pre-header stress did not force every splice strictly before every assignment');
}
const preHeaderSpliceStressLine = JSON.stringify({
  type: 'message',
  message: { role: 'user', content: preHeaderSpliceStressContent },
});
const preHeaderSpliceStressBytes = Buffer.byteLength(preHeaderSpliceStressLine);
if (preHeaderSpliceStressBytes < 1_500_000 || preHeaderSpliceStressBytes >= 2 * 1024 * 1024) {
  throw new Error('pre-header shell-splice linear stress fixture left the bounded near-2-MiB range');
}
await fs.writeFile(preHeaderSpliceStressSessionFile, preHeaderSpliceStressLine);
const preHeaderSpliceStressStartedAt = Date.now();
await handler(afterEvent(preHeaderSpliceStressSessionKey, preHeaderSpliceStressSessionFile));
const preHeaderSpliceStressElapsedMs = Date.now() - preHeaderSpliceStressStartedAt;
const preHeaderSpliceStressHandoff = await fs.readFile(
  currentPath(preHeaderSpliceStressSessionKey),
  'utf8',
);
if (preHeaderSpliceStressElapsedMs >= 10_000
    || preHeaderSpliceStressHandoff.includes(preHeaderSpliceStressSentinel)
    || !preHeaderSpliceStressHandoff.includes(preHeaderSpliceStressHead)) {
  throw new Error(`pre-header shell-splice stress was non-linear or failed redaction: ${JSON.stringify({
    elapsedMs: preHeaderSpliceStressElapsedMs,
    sentinelSurvived: preHeaderSpliceStressHandoff.includes(preHeaderSpliceStressSentinel),
    headPresent: preHeaderSpliceStressHandoff.includes(preHeaderSpliceStressHead),
    fixtureBytes: preHeaderSpliceStressBytes,
  })}`);
}

const quotedKeyShellSessionKey = 'agent:main:p1c-quoted-key-shell-intersection';
const quotedKeyShellSessionFile = path.join(root, 'p1c-quoted-key-shell-intersection.jsonl');
const quotedKeyShellAuthorizationCredential = 'quotedKeyShellAuthOpaque47';
const quotedKeyShellCookieCredential = 'quotedKeyShellCookieOpaque48';
const processSubProxyCredential = 'processSubProxyOpaque49';
const processSubSetCookieCredential = 'processSubSetCookieOpaque50';
const quotedKeyShellValues = [
  `curl -H 'Authorization':'Digest username="u"',response=${quotedKeyShellAuthorizationCredential} https://example.invalid`,
  `curl -H "Cookie":"sid=decoy",$(printf ${quotedKeyShellCookieCredential})`,
  `curl -H "Proxy-Authorization":"Digest decoy",<(printf ${processSubProxyCredential})`,
  `curl -H "Set-Cookie":"sid=decoy",>(printf ${processSubSetCookieCredential})`,
];
const quotedKeyShellSecrets = [
  quotedKeyShellAuthorizationCredential,
  quotedKeyShellCookieCredential,
  processSubProxyCredential,
  processSubSetCookieCredential,
];
for (const [index, credential] of quotedKeyShellSecrets.entries()) {
  const value = quotedKeyShellValues[index];
  const hasQuotedAdjacency = value.includes('":"') || value.includes("':'");
  if (!value.includes(credential) || !hasQuotedAdjacency) {
    throw new Error('quoted-key shell intersection fixture lost quoted key/value adjacency');
  }
}
await fs.writeFile(quotedKeyShellSessionFile, quotedKeyShellValues.map((content, index) => JSON.stringify({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
})).join('\n'));
await handler(afterEvent(quotedKeyShellSessionKey, quotedKeyShellSessionFile));
const quotedKeyShellHandoff = await fs.readFile(currentPath(quotedKeyShellSessionKey), 'utf8');
if (quotedKeyShellSecrets.some((credential) => quotedKeyShellHandoff.includes(credential))) {
  throw new Error('quoted-key shell intersection credential survived persisted handoff redaction');
}

const structuredVariantsSessionKey = 'agent:main:p1c-structured-header-variants';
const structuredVariantsSessionFile = path.join(root, 'p1c-structured-header-variants.jsonl');
const prettyStructuredCredential = 'prettyStructuredAuthOpaque51';
const arrayStructuredCookieCredential = 'arrayStructuredCookieOpaque52';
const prettyStructuredSafePath = '/tmp/pretty-structured-safe';
const arrayStructuredSafePath = '/tmp/array-structured-safe';
const prettyStructuredValue = JSON.stringify({
  Authorization: `Basic ${prettyStructuredCredential}`,
  safePath: prettyStructuredSafePath,
}, null, 2);
const arrayStructuredValue = JSON.stringify([{
  Cookie: `sid=${arrayStructuredCookieCredential}`,
  safePath: arrayStructuredSafePath,
}]);
await fs.writeFile(structuredVariantsSessionFile, [prettyStructuredValue, arrayStructuredValue]
  .map((content) => JSON.stringify({ type: 'message', message: { role: 'user', content } }))
  .join('\n'));
await handler(afterEvent(structuredVariantsSessionKey, structuredVariantsSessionFile));
const structuredVariantsHandoff = await fs.readFile(currentPath(structuredVariantsSessionKey), 'utf8');
if (structuredVariantsHandoff.includes(prettyStructuredCredential)
    || structuredVariantsHandoff.includes(arrayStructuredCookieCredential)) {
  throw new Error('pretty or array structured header credential survived persisted handoff redaction');
}
if (!structuredVariantsHandoff.includes(prettyStructuredSafePath)
    || !structuredVariantsHandoff.includes(arrayStructuredSafePath)) {
  throw new Error('pretty or array structured safe field was over-redacted');
}

const structuralJsonSessionKey = 'agent:main:p1c-structural-json-headers';
const structuralJsonSessionFile = path.join(root, 'p1c-structural-json-headers.jsonl');
const embeddedJsonShellCredential = 'embeddedJsonShellOpaque53';
const escapedAuthorizationKeyCredential = 'escapedAuthKeyOpaque54';
const nestedAuthorizationCredential = 'nestedAuthOpaque55';
const nestedProxyCredential = 'nestedProxyOpaque56';
const nestedCookieCredential = 'nestedCookieOpaque57';
const nestedSetCookieCredential = 'nestedSetCookieOpaque58';
const nestedJsonStringCredential = 'nestedJsonStringOpaque59';
const topLevelJsonStringCredential = 'topLevelJsonStringOpaque60';
const repeatedJsonStringCredential = 'repeatedJsonStringOpaque73';
const embeddedJsonSafePath = '/tmp/embedded-json-shell-safe';
const escapedKeySafePath = '/tmp/escaped-key-safe';
const nestedJsonSafePath = '/tmp/nested-json-safe';
const nestedJsonStringSafePath = '/tmp/nested-json-string-safe';
const topLevelJsonStringSafePath = '/tmp/top-level-json-string-safe';
const repeatedJsonStringSafePath = '/tmp/repeated-json-string-safe';
const embeddedJsonShellValue = JSON.stringify({
  cmd: `curl -H 'Cookie':'sid=decoy',$(printf ${embeddedJsonShellCredential})`,
  safePath: embeddedJsonSafePath,
});
const escapedAuthorizationKeyValue = String.raw`{"\u0041uthorization":"Basic ${escapedAuthorizationKeyCredential}","safePath":"${escapedKeySafePath}"}`;
const nestedPrettyJsonValue = JSON.stringify({
  headers: {
    Authorization: `Basic ${nestedAuthorizationCredential}`,
    'Proxy-Authorization': `Digest ${nestedProxyCredential}`,
    Cookie: `sid=${nestedCookieCredential}`,
    'Set-Cookie': `sid=${nestedSetCookieCredential}`,
  },
  safePath: nestedJsonSafePath,
  safeJsonLikeStrings: ['1.2300', 'true', 'null'],
}, null, 2);
const nestedJsonStringValue = JSON.stringify({
  payload: String.raw`{"\u0043ookie":"sid=${nestedJsonStringCredential}"}`,
  safePath: nestedJsonStringSafePath,
});
const topLevelJsonStringValue = JSON.stringify(
  String.raw`{"\u0041uthorization":"Basic ${topLevelJsonStringCredential}","safePath":"${topLevelJsonStringSafePath}"}`,
);
const repeatedJsonStringValue = JSON.stringify(JSON.stringify(JSON.stringify({
  Authorization: `Basic ${repeatedJsonStringCredential}`,
  safePath: repeatedJsonStringSafePath,
})));
const escapedAuthorizationKeyObject = JSON.parse(escapedAuthorizationKeyValue);
const topLevelJsonStringObject = JSON.parse(JSON.parse(topLevelJsonStringValue));
let repeatedJsonStringObject = repeatedJsonStringValue;
for (let layer = 0; layer < 3; layer += 1) repeatedJsonStringObject = JSON.parse(repeatedJsonStringObject);
if (!Object.hasOwn(escapedAuthorizationKeyObject, 'Authorization')
    || !Object.hasOwn(topLevelJsonStringObject, 'Authorization')
    || !Object.hasOwn(repeatedJsonStringObject, 'Authorization')
    || !escapedAuthorizationKeyValue.includes('\\u0041uthorization')
    || !nestedJsonStringValue.includes('\\\\u0043ookie')
    || !embeddedJsonShellValue.includes(`$(printf ${embeddedJsonShellCredential})`)
    || !nestedPrettyJsonValue.includes(`\n  "safePath": "${nestedJsonSafePath}"`)) {
  throw new Error('structural JSON header fixture lost escaped-key, embedded-shell, or nested-pretty shape');
}
await fs.writeFile(structuralJsonSessionFile, [
  embeddedJsonShellValue,
  escapedAuthorizationKeyValue,
  nestedPrettyJsonValue,
  nestedJsonStringValue,
  topLevelJsonStringValue,
  repeatedJsonStringValue,
].map((content) => JSON.stringify({
  type: 'message',
  message: { role: 'user', content },
})).join('\n'));
await handler(afterEvent(structuralJsonSessionKey, structuralJsonSessionFile));
const structuralJsonHandoff = await fs.readFile(currentPath(structuralJsonSessionKey), 'utf8');
const structuralJsonSecrets = [
  embeddedJsonShellCredential,
  escapedAuthorizationKeyCredential,
  nestedAuthorizationCredential,
  nestedProxyCredential,
  nestedCookieCredential,
  nestedSetCookieCredential,
  nestedJsonStringCredential,
  topLevelJsonStringCredential,
  repeatedJsonStringCredential,
];
if (structuralJsonSecrets.some((credential) => structuralJsonHandoff.includes(credential))) {
  throw new Error('structural JSON header or embedded shell credential survived persisted handoff redaction');
}
for (const safePath of [
  embeddedJsonSafePath,
  escapedKeySafePath,
  nestedJsonSafePath,
  nestedJsonStringSafePath,
  topLevelJsonStringSafePath,
  repeatedJsonStringSafePath,
]) {
  if (!structuralJsonHandoff.includes(safePath)) {
    throw new Error('structural JSON safe field was over-redacted');
  }
}
if (!structuralJsonHandoff.includes('1.2300')) {
  throw new Error('JSON-looking primitive safe string was normalized during structural redaction');
}

const structuralDepthSessionKey = 'agent:main:p1c-structural-json-depth';
const structuralDepthSessionFile = path.join(root, 'p1c-structural-json-depth.jsonl');
const depth64Credential = 'depthBoundaryAuthOpaque66';
const depth65Credential = 'depthFailSafeAuthOpaque67';
const depth64SafePath = '/tmp/depth-64-safe';
const depth65DiscardedSafePath = '/tmp/depth-65-discarded';
const depth65OuterSafePath = '/tmp/depth-65-outer-safe';
let depth64Value = {
  Authorization: `Basic ${depth64Credential}`,
  safePath: depth64SafePath,
};
for (let depth = 0; depth < 63; depth += 1) depth64Value = { child: depth64Value };
let depth65Value = {
  Authorization: `Basic ${depth65Credential}`,
  safePath: depth65DiscardedSafePath,
};
for (let depth = 0; depth < 65; depth += 1) depth65Value = { child: depth65Value };
depth65Value.outerSafePath = depth65OuterSafePath;
await fs.writeFile(structuralDepthSessionFile, [depth64Value, depth65Value]
  .map((content) => JSON.stringify({
    type: 'message',
    message: { role: 'user', content: JSON.stringify(content) },
  }))
  .join('\n'));
await handler(afterEvent(structuralDepthSessionKey, structuralDepthSessionFile));
const structuralDepthHandoff = await fs.readFile(currentPath(structuralDepthSessionKey), 'utf8');
if (structuralDepthHandoff.includes(depth64Credential)
    || structuralDepthHandoff.includes(depth65Credential)) {
  throw new Error('structural JSON depth-bound credential survived persisted handoff redaction');
}
if (!structuralDepthHandoff.includes(depth64SafePath)
    || !structuralDepthHandoff.includes(depth65OuterSafePath)
    || !structuralDepthHandoff.includes('[REDACTED_STRUCTURED_DEPTH]')
    || structuralDepthHandoff.includes(depth65DiscardedSafePath)) {
  throw new Error('structural JSON depth boundary did not preserve or fail safe as documented');
}

const ancestorSymlinkSessionKey = 'agent:main:p1c-ancestor-symlink';
const ancestorSymlinkSource = path.join(root, 'p1c-ancestor-symlink.jsonl');
const ancestorSymlinkSentinel = 'P1C_ANCESTOR_SYMLINK_TRANSCRIPT_MUST_NOT_BIND';
await fs.writeFile(ancestorSymlinkSource, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: ancestorSymlinkSentinel },
}));
const ancestorSymlinkAuthority = await sessionAuthority.registerSessionFixture(
  ancestorSymlinkSessionKey,
  'p1c-ancestor-symlink-id',
  ancestorSymlinkSource,
);
const agentsPath = path.join(root, '.openclaw', 'agents');
const redirectedAgentsPath = path.join(root, '.openclaw', 'redirected-agents');
await fs.rename(agentsPath, redirectedAgentsPath);
await fs.symlink(redirectedAgentsPath, agentsPath);
const ancestorSymlinkEvent = afterEvent(ancestorSymlinkSessionKey, ancestorSymlinkSource);
ancestorSymlinkEvent.context.sessionEntry.sessionId = ancestorSymlinkAuthority.sessionId;
ancestorSymlinkEvent.context.sessionEntry.sessionFile = ancestorSymlinkAuthority.sessionFile;
try {
  await sessionAuthority.rawHandler(ancestorSymlinkEvent);
} finally {
  await fs.unlink(agentsPath);
  await fs.rename(redirectedAgentsPath, agentsPath);
}
if ((await fs.readFile(currentPath(ancestorSymlinkSessionKey), 'utf8')).includes(ancestorSymlinkSentinel)) {
  throw new Error('symlinked authoritative ancestor redirected the trusted sessions hierarchy');
}

const storeRaceSessionKey = 'agent:main:p1c-store-post-read-race';
const storeRaceSource = path.join(root, 'p1c-store-post-read-race.jsonl');
const storeRaceSentinel = 'P1C_TORN_SESSIONS_STORE_MUST_NOT_BIND';
await fs.writeFile(storeRaceSource, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: storeRaceSentinel },
}));
const storeRaceAuthority = await sessionAuthority.registerSessionFixture(
  storeRaceSessionKey,
  'p1c-store-post-read-race-id',
  storeRaceSource,
);
const storeRaceBytes = await fs.readFile(sessionAuthority.sessionsStorePath);
const changedStoreRaceBytes = Buffer.from(storeRaceBytes);
changedStoreRaceBytes[changedStoreRaceBytes.length - 1] = changedStoreRaceBytes.at(-1) === 0x0a ? 0x20 : 0x0a;
const originalOpenForStoreRace = fs.open;
let storeRaceMutated = false;
let storeRaceStatCount = 0;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForStoreRace.call(fs, target, ...args);
  if (String(target) === sessionAuthority.sessionsStorePath) {
    const originalHandleRead = handle.read.bind(handle);
    const originalHandleStat = handle.stat.bind(handle);
    handle.stat = async (...statArgs) => {
      storeRaceStatCount += 1;
      return originalHandleStat(...statArgs);
    };
    handle.read = async (...readArgs) => {
      const result = await originalHandleRead(...readArgs);
      if (!storeRaceMutated) {
        storeRaceMutated = true;
        await fs.writeFile(sessionAuthority.sessionsStorePath, changedStoreRaceBytes, { mode: 0o600 });
      }
      return result;
    };
  }
  return handle;
};
const storeRaceEvent = afterEvent(storeRaceSessionKey, storeRaceSource);
storeRaceEvent.context.sessionEntry.sessionId = storeRaceAuthority.sessionId;
storeRaceEvent.context.sessionEntry.sessionFile = storeRaceAuthority.sessionFile;
try {
  await sessionAuthority.rawHandler(storeRaceEvent);
} finally {
  fs.open = originalOpenForStoreRace;
  await fs.writeFile(sessionAuthority.sessionsStorePath, storeRaceBytes, { mode: 0o600 });
}
if (!storeRaceMutated
    || storeRaceStatCount < 2
    || (await fs.readFile(currentPath(storeRaceSessionKey), 'utf8')).includes(storeRaceSentinel)) {
  throw new Error(`sessions store mutation during read was cached as authoritative: ${JSON.stringify({
    storeRaceMutated,
    storeRaceStatCount,
  })}`);
}

const provenanceSignalSessionKey = 'agent:main:p1c-untrusted-completion-signal';
const provenanceSignalSessionFile = path.join(root, 'p1c-untrusted-completion-signal.jsonl');
const untrustedCompletionSignal = 'P1C_TOOL_OUTPUT_READY_COMMIT_ERROR';
await fs.writeFile(provenanceSignalSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Continue only from trusted assistant status.' } }),
  JSON.stringify({ type: 'message', message: { role: 'tool', content: untrustedCompletionSignal } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Work remains in progress.' } }),
].join('\n'));
await handler(afterEvent(provenanceSignalSessionKey, provenanceSignalSessionFile));
const provenanceSignalHandoff = await fs.readFile(currentPath(provenanceSignalSessionKey), 'utf8');
const untrustedSignalOccurrences = provenanceSignalHandoff.split(untrustedCompletionSignal).length - 1;
if (untrustedSignalOccurrences !== 1) {
  throw new Error(`untrusted tool output was promoted into deterministic completion state: ${untrustedSignalOccurrences}`);
}

const tailBoundarySummary = [
  '## Decisions',
  '- none',
  '## Open TODOs',
  '- none',
  '## Constraints/Rules',
  '- none',
  '## Pending user asks',
  '- none',
  '## Exact identifiers',
  '- none',
].join('\n');
const boundaryAlignedSessionKey = 'agent:main:p1c-tail-boundary-aligned';
const boundaryAlignedSessionFile = path.join(root, 'p1c-tail-boundary-aligned.jsonl');
const boundaryAlignedRow = `${JSON.stringify({ type: 'compaction', summary: tailBoundarySummary })}\n`;
const boundaryAlignedTailBytes = 2 * 1024 * 1024;
const boundaryAlignedRowBytes = Buffer.from(boundaryAlignedRow);
const boundaryAlignedTail = Buffer.concat([
  boundaryAlignedRowBytes,
  Buffer.alloc(boundaryAlignedTailBytes - boundaryAlignedRowBytes.length, 0x20),
]);
await fs.writeFile(boundaryAlignedSessionFile, Buffer.concat([
  Buffer.from(`${'P'.repeat(127)}\n`),
  boundaryAlignedTail,
]));
await handler(afterEvent(boundaryAlignedSessionKey, boundaryAlignedSessionFile, { summaryLength: tailBoundarySummary.length }));
index = JSON.parse(await fs.readFile(path.join(handoffDir, 'index.json'), 'utf8'));
const boundaryAlignedAudit = parseAuditFromIndex(index, boundaryAlignedSessionKey);
if (boundaryAlignedAudit.available !== true
    || boundaryAlignedAudit.ok !== true
    || boundaryAlignedAudit.summaryLength !== tailBoundarySummary.length) {
  throw new Error(`complete compaction aligned to the tail boundary was discarded: ${JSON.stringify(boundaryAlignedAudit)}`);
}

const cacheCapacityFixtures = [];
let evictedStoreOpenCount = 0;
let evictedStoreStatCount = 0;
let evictedStoreReadCount = 0;
try {
  for (let cacheIndex = 0; cacheIndex < 17; cacheIndex += 1) {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), `compact-handoff-cache-cap-${cacheIndex}-`));
    const cacheHarness = await createSessionAuthorityHarness(rawHandler, cacheRoot);
    const cacheSessionKey = `agent:main:p1c-cache-cap-${cacheIndex}`;
    const cacheSource = path.join(cacheRoot, `cache-cap-${cacheIndex}.jsonl`);
    await fs.writeFile(cacheSource, JSON.stringify({
      type: 'message',
      message: { role: 'user', content: `Cache capacity fixture ${cacheIndex}` },
    }));
    const cacheAuthority = await cacheHarness.registerSessionFixture(
      cacheSessionKey,
      `p1c-cache-cap-${cacheIndex}-id`,
      cacheSource,
    );
    const cacheEvent = afterEvent(cacheSessionKey, cacheSource);
    cacheEvent.context.workspaceDir = cacheRoot;
    cacheEvent.context.sessionEntry.sessionId = cacheAuthority.sessionId;
    cacheEvent.context.sessionEntry.sessionFile = cacheAuthority.sessionFile;
    await cacheHarness.rawHandler(cacheEvent);
    cacheCapacityFixtures.push({ cacheRoot, cacheHarness, cacheEvent });
  }

  const firstCacheFixture = cacheCapacityFixtures[0];
  process.env.HOME = firstCacheFixture.cacheRoot;
  const originalOpenForCacheEviction = fs.open;
  fs.open = async (target, ...args) => {
    const handle = await originalOpenForCacheEviction.call(fs, target, ...args);
    if (String(target) === firstCacheFixture.cacheHarness.sessionsStorePath) {
      evictedStoreOpenCount += 1;
      const originalHandleStat = handle.stat.bind(handle);
      const originalHandleRead = handle.read.bind(handle);
      handle.stat = async (...statArgs) => {
        evictedStoreStatCount += 1;
        return originalHandleStat(...statArgs);
      };
      handle.read = async (...readArgs) => {
        evictedStoreReadCount += 1;
        return originalHandleRead(...readArgs);
      };
    }
    return handle;
  };
  try {
    await firstCacheFixture.cacheHarness.rawHandler(firstCacheFixture.cacheEvent);
  } finally {
    fs.open = originalOpenForCacheEviction;
  }
} finally {
  process.env.HOME = root;
  await Promise.all(cacheCapacityFixtures.map(({ cacheRoot }) => fs.rm(cacheRoot, { recursive: true, force: true })));
}
if (evictedStoreOpenCount !== 1 || evictedStoreStatCount !== 2 || evictedStoreReadCount < 1) {
  throw new Error(`sessions-store cache did not evict beyond 16 entries: ${JSON.stringify({
    evictedStoreOpenCount,
    evictedStoreStatCount,
    evictedStoreReadCount,
  })}`);
}

const result = {
  ok: true,
  boundedTailBytes: boundedTailReadBytes,
  boundedTailRequestedBytes,
  boundedTailOpenCount,
  boundedTailStart: boundedTailReadPositions[0],
  expectedTailStart,
  goodSummaryLength: goodSummary.length,
  inclusiveMaxSummaryLength: boundaryAudit.summaryLength,
  badReasonCount: badAudit.reasons.length,
  newestCompactionOnly: true,
  beforeAndEarlyAuditRetention: true,
  overLimitAuditRetention: true,
  persistedAuditSchemaAllowlisted: true,
  sessionsStoreCacheHitReads: cachedStoreReadCount,
  sessionsStoreCacheHitStats: cachedStoreStatCount,
  sessionsStoreInvalidationReads: invalidatedStoreReadCount,
  sessionsStoreSafetyMatrix: 'mode-owner-symlink-size-pass',
  identifierSafetyMatrix: 'agent-session-topic-pass',
  newestCompleteBeforeTruncated: true,
  latestRealUserProvenance: true,
  sessionsStoreCacheEvictionReads: evictedStoreReadCount,
  exactDirectPathBinding: true,
  openedTranscriptIdentityBinding: 'ESTALE-fail-closed',
  unavailableTailRead: tailReadFailureAudit.reasons[0],
  structuredAuthorizationRedaction: 'quoted-and-assigned-pass',
  continuedAuthorizationRedaction: 'folded-and-shell-wrapped-pass',
  structuredCookieRedaction: 'quoted-and-assigned-pass',
  shellAdjacentHeaderRedaction: 'quote-concat-and-unquoted-continuation-pass',
  quotedFoldHeaderRedaction: 'lf-crlf-mixed-continuation-pass',
  structuredDelimiterPreservation: 'compact-json-safe-field-pass',
  dynamicShellHeaderRedaction: 'expansion-fail-safe-pass',
  enclosingQuoteDynamicRedaction: 'nested-quote-fail-safe-pass',
  adjacentQuotedDynamicRedaction: 'quote-state-fail-safe-pass',
  splicedDynamicShellRedaction: 'lf-crlf-multi-splice-pass',
  splicedHeaderAssignmentRedaction: 'bounded-remainder-fail-safe-pass',
  spliceQuoteParityRedaction: 'residual-escape-pass',
  spliceLinearStress: 'bidirectional-near-2mib-pass',
  quotedKeyShellIntersection: 'structural-json-dispatch-pass',
  structuredVariantPreservation: 'pretty-array-safe-field-pass',
  structuralJsonRedaction: 'decoded-keys-nested-safe-fields-pass',
  topLevelJsonStringRedaction: 'nested-container-pass',
  repeatedJsonStringRedaction: 'recursive-string-layer-pass',
  jsonLikePrimitiveStringPreservation: 'lexical-pass',
  structuralDepthFailSafe: 'depth64-65-pass',
  cleaned: true,
};
await fs.rm(root, { recursive: true, force: true });
try {
  await fs.access(root);
  throw new Error('P1-C native audit suite left its temporary tree behind');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(JSON.stringify(result));
