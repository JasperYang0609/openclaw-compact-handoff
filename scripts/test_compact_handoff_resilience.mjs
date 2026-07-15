#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import handler from '../hooks/compact-handoff/handler.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-resilience-'));
const handoffDir = path.join(root, 'memory', 'session_handoffs');
await fs.mkdir(handoffDir, { recursive: true });

function slug(value) {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'unknown';
}

const archiveInstanceSuffixPattern = /^@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fixtureUuid(index, family = '00000000') {
  return `${family}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function eventFor(sessionKey, action, sessionFile, extraEntry = {}) {
  return {
    type: 'session',
    action,
    sessionKey,
    timestamp: new Date().toISOString(),
    messages: [],
    context: {
      workspaceDir: root,
      sessionEntry: {
        sessionId: `${slug(sessionKey)}-session`,
        sessionFile,
        ...extraEntry,
      },
      messageCount: 4,
      tokenCount: 1234,
      compactedCount: 2,
      summaryLength: 900,
      tokensBefore: 12000,
      tokensAfter: 4000,
    },
  };
}

async function writeTranscript(name, content = 'resilience test user request') {
  const file = path.join(root, `${name}.jsonl`);
  await fs.writeFile(file, JSON.stringify({ type: 'message', message: { role: 'user', content } }));
  return file;
}

async function archiveNames(sessionKey, phase) {
  const sessionSlug = slug(sessionKey);
  return (await fs.readdir(handoffDir)).filter((name) => {
    const match = name.match(/^\d{8}T\d{6}_(before|after|early)_(.+)\.md$/);
    if (!match || match[1] !== phase) return false;
    if (match[2] === sessionSlug) return true;
    if (!match[2].startsWith(sessionSlug)) return false;
    return archiveInstanceSuffixPattern.test(match[2].slice(sessionSlug.length));
  });
}

function generationId(content) {
  return content.match(/^- generationId: (.+)$/m)?.[1];
}

function handoffSessionKey(content) {
  return content.match(/^- sessionKey: (.+)$/m)?.[1];
}

// Same-second lifecycle writes must never overwrite an archive.
const collisionKey = 'agent:main:same-second';
const collisionFile = await writeTranscript('same-second');
await Promise.all([
  handler(eventFor(collisionKey, 'compact:before', collisionFile)),
  handler(eventFor(collisionKey, 'compact:before', collisionFile)),
]);
const collisionArchives = await archiveNames(collisionKey, 'before');
if (collisionArchives.length !== 2 || new Set(collisionArchives).size !== 2) {
  throw new Error(`same-second archives were not unique: ${JSON.stringify(collisionArchives)}`);
}

// Concurrent index updates must be serialized and lossless.
const concurrentKeys = Array.from({ length: 20 }, (_, index) => `agent:main:concurrent-${index}`);
await Promise.all(concurrentKeys.map(async (sessionKey, index) => {
  const transcript = await writeTranscript(`concurrent-${index}`, `concurrent request ${index}`);
  await handler(eventFor(sessionKey, 'compact:before', transcript));
}));
const indexPath = path.join(handoffDir, 'index.json');
const concurrentIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const missingConcurrent = concurrentKeys.filter((sessionKey) => !concurrentIndex.sessions?.[sessionKey]);
if (missingConcurrent.length) {
  throw new Error(`concurrent index updates were lost: ${missingConcurrent.join(', ')}`);
}

// Invalid JSON must be preserved as a corrupt artifact before a new index is written.
const malformedIndexSecret = 'P1B_INDEX_WARNING_SECRET_123456789';
await fs.writeFile(indexPath, malformedIndexSecret, 'utf8');
const corruptKey = 'agent:main:corrupt-index';
const corruptFile = await writeTranscript('corrupt-index');
const capturedWarnings = [];
const originalConsoleWarn = console.warn;
console.warn = (...args) => capturedWarnings.push(args.map(String).join(' '));
try {
  await handler(eventFor(corruptKey, 'compact:before', corruptFile));
} finally {
  console.warn = originalConsoleWarn;
}
if (capturedWarnings.some((warning) => warning.includes('P1B_INDEX_'))) {
  throw new Error('corrupt-index warning echoed attacker-controlled secret input');
}
const recoveredIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
if (!recoveredIndex.sessions?.[corruptKey]) {
  throw new Error('corrupt index recovery did not retain the new session');
}
const corruptCopies = (await fs.readdir(handoffDir)).filter((name) => name.startsWith('index.json.corrupt-'));
if (!corruptCopies.length) {
  throw new Error('corrupt index was silently overwritten without a preserved copy');
}

await fs.writeFile(indexPath, JSON.stringify({ sessions: [] }), 'utf8');
const malformedShapeKey = 'agent:main:malformed-index-shape';
const malformedShapeFile = await writeTranscript('malformed-index-shape');
await handler(eventFor(malformedShapeKey, 'compact:before', malformedShapeFile));
const shapeRecoveredIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
if (!shapeRecoveredIndex.sessions || Array.isArray(shapeRecoveredIndex.sessions) || !shapeRecoveredIndex.sessions[malformedShapeKey]) {
  throw new Error('valid JSON with an invalid sessions shape was not recovered fail-closed');
}
const corruptCopiesAfterShape = (await fs.readdir(handoffDir)).filter((name) => name.startsWith('index.json.corrupt-'));
if (corruptCopiesAfterShape.length <= corruptCopies.length) {
  throw new Error('invalid index shape was not preserved as a corrupt copy');
}

// Non-corruption read failures must not quarantine or replace a valid index.
const ioFailureFile = await writeTranscript('index-read-io-failure');
const corruptCountBeforeIoFailure = corruptCopiesAfterShape.length;
const indexBeforeIoFailure = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const entryBeforeIoFailure = structuredClone(indexBeforeIoFailure.sessions[malformedShapeKey]);
const currentBeforeIoFailure = await fs.readFile(entryBeforeIoFailure.currentPath, 'utf8');
const archivesBeforeIoFailure = await archiveNames(malformedShapeKey, 'before');
await fs.chmod(indexPath, 0o000);
try {
  await handler(eventFor(malformedShapeKey, 'compact:before', ioFailureFile));
} finally {
  await fs.chmod(indexPath, 0o600).catch(() => undefined);
}
const corruptCountAfterIoFailure = (await fs.readdir(handoffDir)).filter((name) => name.startsWith('index.json.corrupt-')).length;
if (corruptCountAfterIoFailure !== corruptCountBeforeIoFailure) {
  throw new Error('non-corruption index read failure was mislabeled and quarantined as corrupt');
}
const indexAfterIoFailure = JSON.parse(await fs.readFile(indexPath, 'utf8'));
if (JSON.stringify(indexAfterIoFailure.sessions?.[malformedShapeKey]) !== JSON.stringify(entryBeforeIoFailure)) {
  throw new Error('non-corruption index read failure replaced prior live index data');
}
const currentAfterIoFailure = await fs.readFile(entryBeforeIoFailure.currentPath, 'utf8');
if (generationId(currentAfterIoFailure) !== generationId(currentBeforeIoFailure)) {
  throw new Error('non-corruption index read failure left current handoff inconsistent with the live index');
}
const archivesAfterIoFailure = await archiveNames(malformedShapeKey, 'before');
if (archivesAfterIoFailure.length !== archivesBeforeIoFailure.length) {
  throw new Error('failed current/index transaction left an orphan archive');
}

// Failure after current replacement but before index rename must restore the prior generation.
const rollbackFile = await writeTranscript('index-rename-rollback', 'index rename rollback request');
const rollbackIndexBeforeRaw = await fs.readFile(indexPath, 'utf8');
const rollbackIndexBefore = JSON.parse(rollbackIndexBeforeRaw);
const rollbackEntryBefore = structuredClone(rollbackIndexBefore.sessions[malformedShapeKey]);
const rollbackCurrentBefore = await fs.readFile(rollbackEntryBefore.currentPath, 'utf8');
const rollbackArchivesBefore = await archiveNames(malformedShapeKey, 'before');
const originalRename = fs.rename;
let indexRenameFailureInjected = false;
fs.rename = async (source, destination) => {
  if (destination === indexPath) {
    indexRenameFailureInjected = true;
    const error = new Error('injected index rename failure');
    error.code = 'EIO';
    throw error;
  }
  return originalRename(source, destination);
};
try {
  await handler(eventFor(malformedShapeKey, 'compact:before', rollbackFile));
} finally {
  fs.rename = originalRename;
}
if (!indexRenameFailureInjected) throw new Error('index rename rollback fixture did not reach the intended failure point');
const rollbackIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
const rollbackIndexAfter = JSON.parse(rollbackIndexAfterRaw);
if (rollbackIndexAfterRaw !== rollbackIndexBeforeRaw
    || JSON.stringify(rollbackIndexAfter) !== JSON.stringify(rollbackIndexBefore)) {
  throw new Error('failed index rename changed the live index');
}
const rollbackCurrentAfter = await fs.readFile(rollbackEntryBefore.currentPath, 'utf8');
if (generationId(rollbackCurrentAfter) !== generationId(rollbackCurrentBefore)) {
  throw new Error('failed index rename did not restore the prior current generation');
}
const rollbackArchivesAfter = await archiveNames(malformedShapeKey, 'before');
if (rollbackArchivesAfter.length !== rollbackArchivesBefore.length) {
  throw new Error('failed index rename left an uncommitted archive');
}

// Archive retention: only archives are pruned, with five per session/phase and a 30-day age cap.
const retentionKey = 'agent:main:retention';
const retentionSlug = slug(retentionKey);
const now = Date.now();
for (let index = 0; index < 7; index += 1) {
  const archive = path.join(handoffDir, `20990101T00000${index}_before_${retentionSlug}@${fixtureUuid(index)}.md`);
  await fs.writeFile(archive, `recent archive ${index}`);
  const age = new Date(now + 24 * 60 * 60 * 1000 + index * 60_000);
  await fs.utimes(archive, age, age);
}
const oldArchive = path.join(handoffDir, `20000101T000000_before_${retentionSlug}@${fixtureUuid(999999999999)}.md`);
await fs.writeFile(oldArchive, '31-day-old archive');
const oldDate = new Date(now - 31 * 24 * 60 * 60 * 1000);
await fs.utimes(oldArchive, oldDate, oldDate);
const neighborKey = `${retentionKey}_neighbor`;
const neighborSlug = slug(neighborKey);
const neighborArchives = [];
for (let index = 0; index < 6; index += 1) {
  const archive = path.join(handoffDir, `20990101T01000${index}_before_${neighborSlug}@${fixtureUuid(index, '11111111')}.md`);
  neighborArchives.push(archive);
  await fs.writeFile(archive, `neighbor archive ${index}`);
  const age = new Date(now - index * 1000);
  await fs.utimes(archive, age, age);
}
const retentionState = path.join(handoffDir, `session_${retentionSlug}.state.json`);
await fs.writeFile(retentionState, JSON.stringify({ protected: true }));
const retentionFile = await writeTranscript('retention');
await handler(eventFor(retentionKey, 'compact:before', retentionFile));
const retainedArchives = await archiveNames(retentionKey, 'before');
if (retainedArchives.length > 5) {
  throw new Error(`archive retention kept more than five snapshots: ${retainedArchives.length}`);
}
const retentionIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
await fs.access(retentionIndex.sessions?.[retentionKey]?.archivePath).catch(() => {
  throw new Error('retention deleted the archive referenced by the committed index');
});
try {
  await fs.access(oldArchive);
  throw new Error('archive older than 30 days was not pruned');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const protectedState = JSON.parse(await fs.readFile(retentionState, 'utf8'));
if (protectedState.protected !== true) throw new Error('retention modified the per-session state file');
for (const neighborArchive of neighborArchives) {
  await fs.access(neighborArchive).catch(() => {
    throw new Error('retention crossed a session-slug boundary and deleted a neighbor archive');
  });
}
await fs.access(path.join(handoffDir, `session_${retentionSlug}.MEMORY.md`));
await fs.access(indexPath);

// Distinct raw session keys that normalize to the same readable slug must remain isolated.
const collidingSessionA = 'agent:main:a/b';
const collidingSessionB = 'agent:main:a?b';
const losslessPrefixSession = 'agent:main:a_b';
const losslessDelimiterNeighbor = 'agent:main:a_b--neighbor';
const reservedSeparatorSession = 'agent:main:a_b@neighbor';
const collidingFileA = await writeTranscript('slug-collision-a', 'slug collision request A');
const collidingFileB = await writeTranscript('slug-collision-b', 'slug collision request B');
const losslessPrefixFile = await writeTranscript('slug-collision-lossless-prefix', 'lossless prefix request');
const losslessDelimiterNeighborFile = await writeTranscript('slug-collision-delimiter-neighbor', 'lossless delimiter neighbor request');
const reservedSeparatorFile = await writeTranscript('slug-collision-reserved-separator', 'reserved separator request');
for (let index = 0; index < 5; index += 1) {
  await handler(eventFor(collidingSessionA, 'compact:before', collidingFileA));
}
await handler(eventFor(collidingSessionB, 'compact:before', collidingFileB));
const collisionScopedArchives = [];
for (const name of await fs.readdir(handoffDir)) {
  if (!/^\d{8}T\d{6}_before_.*\.md$/.test(name)) continue;
  const content = await fs.readFile(path.join(handoffDir, name), 'utf8');
  if (content.includes(`- sessionKey: ${collidingSessionA}`)) collisionScopedArchives.push({ owner: 'a', name });
  if (content.includes(`- sessionKey: ${collidingSessionB}`)) collisionScopedArchives.push({ owner: 'b', name });
}
const collisionOwnerACount = collisionScopedArchives.filter((entry) => entry.owner === 'a').length;
const collisionOwnerBCount = collisionScopedArchives.filter((entry) => entry.owner === 'b').length;
if (collisionOwnerACount !== 5 || collisionOwnerBCount !== 1) {
  throw new Error(`lossy slug collision crossed archive ownership: a=${collisionOwnerACount} b=${collisionOwnerBCount}`);
}
const collisionIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const collisionCurrentA = collisionIndex.sessions?.[collidingSessionA]?.currentPath;
const collisionCurrentB = collisionIndex.sessions?.[collidingSessionB]?.currentPath;
if (!collisionCurrentA || !collisionCurrentB || collisionCurrentA === collisionCurrentB) {
  throw new Error('lossy slug collision shared a current handoff path');
}
if (!(await fs.readFile(collisionCurrentA, 'utf8')).includes(`- sessionKey: ${collidingSessionA}`)
  || !(await fs.readFile(collisionCurrentB, 'utf8')).includes(`- sessionKey: ${collidingSessionB}`)) {
  throw new Error('colliding raw session keys did not retain independent current handoffs');
}
await handler(eventFor(losslessPrefixSession, 'compact:before', losslessPrefixFile));
for (let index = 0; index < 5; index += 1) {
  await handler(eventFor(losslessDelimiterNeighbor, 'compact:before', losslessDelimiterNeighborFile));
}
await handler(eventFor(losslessPrefixSession, 'compact:before', losslessPrefixFile));
await handler(eventFor(reservedSeparatorSession, 'compact:before', reservedSeparatorFile));
const reservedSeparatorIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const reservedSeparatorCurrent = path.basename(reservedSeparatorIndex.sessions?.[reservedSeparatorSession]?.currentPath || '');
const reservedSeparatorStorageId = reservedSeparatorCurrent.replace(/^session_/, '').replace(/\.MEMORY\.md$/, '');
if (!reservedSeparatorStorageId || reservedSeparatorStorageId.includes('@')) {
  throw new Error(`reserved archive separator leaked into session storage ID: ${reservedSeparatorStorageId}`);
}
const ownershipCounts = { a: 0, b: 0, lossless: 0, delimiterNeighbor: 0, reservedSeparator: 0 };
for (const name of await fs.readdir(handoffDir)) {
  if (!/^\d{8}T\d{6}_before_.*\.md$/.test(name)) continue;
  const content = await fs.readFile(path.join(handoffDir, name), 'utf8');
  const archivedSessionKey = handoffSessionKey(content);
  if (archivedSessionKey === collidingSessionA) ownershipCounts.a += 1;
  if (archivedSessionKey === collidingSessionB) ownershipCounts.b += 1;
  if (archivedSessionKey === losslessPrefixSession) ownershipCounts.lossless += 1;
  if (archivedSessionKey === losslessDelimiterNeighbor) ownershipCounts.delimiterNeighbor += 1;
  if (archivedSessionKey === reservedSeparatorSession) ownershipCounts.reservedSeparator += 1;
}
if (
  ownershipCounts.a !== 5
  || ownershipCounts.b !== 1
  || ownershipCounts.lossless !== 2
  || ownershipCounts.delimiterNeighbor !== 5
  || ownershipCounts.reservedSeparator !== 1
) {
  throw new Error(`lossless storage ID crossed lossy archive ownership: ${JSON.stringify(ownershipCounts)}`);
}

// Concurrent before/after writes for one session must commit current and index coherently.
const transactionKey = 'agent:main:same-session-transaction';
const transactionFile = await writeTranscript('same-session-transaction', 'same-session transaction request');
let transactionMismatches = 0;
for (let round = 0; round < 40; round += 1) {
  await Promise.all(Array.from({ length: 8 }, (_, index) => handler(eventFor(
    transactionKey,
    index % 2 === 0 ? 'compact:before' : 'compact:after',
    transactionFile,
  ))));
  const transactionIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const transactionEntry = transactionIndex.sessions?.[transactionKey];
  const currentContent = await fs.readFile(transactionEntry.currentPath, 'utf8');
  const indexedArchiveContent = await fs.readFile(transactionEntry.archivePath, 'utf8');
  if (generationId(currentContent) !== generationId(indexedArchiveContent)) transactionMismatches += 1;
}
if (transactionMismatches) {
  throw new Error(`same-session current/index/archive generations diverged in ${transactionMismatches} rounds`);
}

// Expanded secret corpus must be removed without hiding ordinary operational references.
const secretValues = {
  bearer: 'P1B_BEARER_SECRET_123456789',
  ghp: `ghp_${'A'.repeat(36)}`,
  githubPat: `github_pat_${'B'.repeat(32)}`,
  slack: ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-'),
  cookie: 'session_cookie=P1B_COOKIE_SECRET_12345',
  queryToken: 'P1B_QUERY_TOKEN_123456789',
  queryKey: 'P1B_QUERY_KEY_123456789',
  privateMaterial: 'P1B_PRIVATE_KEY_MATERIAL_123456789',
  jsonApiKey: 'P1B_JSON_API_KEY_SECRET_123456789',
  inlineCookie: 'P1B_INLINE_COOKIE_SECRET_123456789',
  quotedCookie: 'P1B_QUOTED_COOKIE_SECRET_123456789',
  quotedSetCookie: 'P1B_QUOTED_SET_COOKIE_SECRET_123456789',
  unterminatedPrivateMaterial: 'P1B_UNTERMINATED_PRIVATE_KEY_123456789',
};
const safeValues = {
  snowflake: '1526904494342799421',
  commit: '0acd4790ed26ecc76dfd24b5c31376042b9f666d',
  path: '/Users/example/project/src/handler.ts',
  issue: 'https://github.com/example/project/issues/123',
  inlineUrl: 'https://example.test/health',
};
const secretText = [
  `Keep refs ${safeValues.snowflake} ${safeValues.commit} ${safeValues.path} ${safeValues.issue}`,
  `Authorization: Bearer ${secretValues.bearer}`,
  `GitHub ${secretValues.ghp} ${secretValues.githubPat}`,
  `Slack ${secretValues.slack}`,
  `Cookie: ${secretValues.cookie}`,
  `Set-Cookie: auth=P1B_SET_COOKIE_SECRET_12345; HttpOnly`,
  `Cookie: sid="${secretValues.quotedCookie}"; theme=light`,
  `Set-Cookie: sid='${secretValues.quotedSetCookie}'; Path=/; HttpOnly`,
  `URL https://example.test/api?token=${secretValues.queryToken}&key=${secretValues.queryKey}&signature=P1B_SIGNATURE_SECRET_12345`,
  `JSON {"api_key":"${secretValues.jsonApiKey}"}`,
  `curl -H "Cookie: session=${secretValues.inlineCookie}; mode=test" ${safeValues.inlineUrl}`,
  `curl -H 'Cookie: sid="${secretValues.quotedCookie}"' ${safeValues.inlineUrl}`,
  `curl -H "Cookie: sid=\\"${secretValues.quotedSetCookie}\\"" ${safeValues.inlineUrl}`,
  '-----BEGIN PRIVATE KEY-----',
  secretValues.privateMaterial,
  '-----END PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  secretValues.unterminatedPrivateMaterial,
].join('\n');
const secretKey = 'agent:main:secret-corpus';
const secretFile = await writeTranscript('secret-corpus', secretText);
await handler(eventFor(secretKey, 'compact:before', secretFile));
const secretHandoff = await fs.readFile(path.join(handoffDir, `session_${slug(secretKey)}.MEMORY.md`), 'utf8');
for (const [name, value] of Object.entries(secretValues)) {
  if (secretHandoff.includes(value)) throw new Error(`plaintext secret leaked into handoff: ${name}`);
}
for (const [name, value] of Object.entries(safeValues)) {
  if (!secretHandoff.includes(value)) throw new Error(`ordinary operational reference was over-redacted: ${name}`);
}
if (!secretHandoff.includes('[REDACTED')) throw new Error('expanded secret corpus produced no redaction markers');

// Early refresh hard floor: high bucket and token deltas cannot write every turn.
const concurrentThrottleKey = 'agent:main:throttle-concurrent-first-crossing';
const concurrentThrottleFile = await writeTranscript('throttle-concurrent-first-crossing');
function concurrentEarlyEvent() {
  return {
    type: 'message',
    action: 'preprocessed',
    sessionKey: concurrentThrottleKey,
    timestamp: new Date().toISOString(),
    messages: [],
    context: {
      workspaceDir: root,
      sessionEntry: {
        sessionId: 'throttle-concurrent-session',
        sessionFile: concurrentThrottleFile,
        totalTokens: 7000,
        contextTokens: 10000,
      },
    },
  };
}
await Promise.all([handler(concurrentEarlyEvent()), handler(concurrentEarlyEvent())]);
const concurrentEarlyArchives = await archiveNames(concurrentThrottleKey, 'early');
if (concurrentEarlyArchives.length !== 1) {
  throw new Error(`concurrent first crossing bypassed early-write serialization: ${concurrentEarlyArchives.length}`);
}

const throttleKey = 'agent:main:throttle';
const throttleFile = await writeTranscript('throttle');
function earlyEvent(totalTokens, contextTokens) {
  return {
    type: 'message',
    action: 'preprocessed',
    sessionKey: throttleKey,
    timestamp: new Date().toISOString(),
    messages: [],
    context: {
      workspaceDir: root,
      sessionEntry: {
        sessionId: 'throttle-session',
        sessionFile: throttleFile,
        totalTokens,
        contextTokens,
      },
    },
  };
}
await handler(earlyEvent(7000, 10000));
const throttleCurrent = path.join(handoffDir, `session_${slug(throttleKey)}.MEMORY.md`);
const firstGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
await handler(earlyEvent(7600, 10000));
const immediateHighGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!firstGeneration || immediateHighGeneration !== firstGeneration) {
  throw new Error('75% high bucket bypassed the five-minute hard floor');
}
const throttleState = path.join(handoffDir, `session_${slug(throttleKey)}.state.json`);
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() - 6 * 60 * 1000,
  lastEarlyTokens: 7000,
  lastRatio: 0.70,
  lastBucket: 'soft',
}));
await handler(earlyEvent(7600, 10000));
const bucketChangeGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!bucketChangeGeneration || bucketChangeGeneration === firstGeneration) {
  throw new Error('soft-to-high bucket transition did not refresh after the hard floor');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() - 21 * 60 * 1000,
  lastEarlyTokens: 7600,
  lastRatio: 0.76,
  lastBucket: 'high',
}));
await handler(earlyEvent(7000, 10000));
const highToSoftGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (highToSoftGeneration !== bucketChangeGeneration) {
  throw new Error('high-to-soft pressure change incorrectly triggered after the normal interval');
}
const observedSoftState = JSON.parse(await fs.readFile(throttleState, 'utf8'));
if (observedSoftState.lastObservedBucket !== 'soft') {
  throw new Error('high-to-soft no-write observation was not retained for directional recovery');
}
await fs.writeFile(throttleState, JSON.stringify({
  ...observedSoftState,
  lastEarlyAtMs: Date.now() - 6 * 60 * 1000,
}));
await handler(earlyEvent(7600, 10000));
const reascendingHighGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!reascendingHighGeneration || reascendingHighGeneration === bucketChangeGeneration) {
  throw new Error('observed soft-to-high recovery did not refresh after the hard floor');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now(),
  lastEarlyTokens: 7600,
  lastRatio: 0.76,
  lastBucket: 'high',
}));
await handler(earlyEvent(17600, 20000));
const immediateDeltaGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (immediateDeltaGeneration !== reascendingHighGeneration) {
  throw new Error('10K token delta bypassed the five-minute hard floor');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() - 6 * 60 * 1000,
  lastEarlyTokens: 7600,
  lastRatio: 0.76,
  lastBucket: 'high',
}));
await handler(earlyEvent(17600, 20000));
const postFloorDeltaGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!postFloorDeltaGeneration || postFloorDeltaGeneration === reascendingHighGeneration) {
  throw new Error('10K token delta did not refresh after the five-minute hard floor');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() - 6 * 60 * 1000,
  lastEarlyTokens: 3000,
  lastRatio: 0.70,
  lastBucket: 'soft',
  lastObservedBucket: 'soft',
}));
await handler(earlyEvent(13000, 20000));
const softToSoftDeltaGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (softToSoftDeltaGeneration !== postFloorDeltaGeneration) {
  throw new Error('soft-to-soft 10K token delta incorrectly triggered an early refresh');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() - 21 * 60 * 1000,
  lastEarlyTokens: 17600,
  lastRatio: 0.88,
  lastBucket: 'high',
}));
await handler(earlyEvent(17600, 20000));
const intervalGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!intervalGeneration || intervalGeneration === postFloorDeltaGeneration) {
  throw new Error('20-minute normal refresh interval did not produce a new generation');
}
await fs.writeFile(throttleState, JSON.stringify({
  lastEarlyAtMs: Date.now() + 24 * 60 * 60 * 1000,
  lastEarlyTokens: 17600,
  lastRatio: 0.88,
  lastBucket: 'high',
}));
await handler(earlyEvent(30000, 30000));
const futureClockGeneration = generationId(await fs.readFile(throttleCurrent, 'utf8'));
if (!futureClockGeneration || futureClockGeneration === intervalGeneration) {
  throw new Error('future persisted clock suppressed a high-pressure recovery write');
}
const recoveredClockState = JSON.parse(await fs.readFile(throttleState, 'utf8'));
if (recoveredClockState.lastEarlyAtMs > Date.now() + 1000) {
  throw new Error('future persisted clock was not normalized after recovery');
}

const tempArtifacts = (await fs.readdir(handoffDir)).filter((name) => name.includes('.tmp-'));
if (tempArtifacts.length) throw new Error(`atomic-write temp artifacts were left behind: ${tempArtifacts.join(', ')}`);

const result = {
  ok: true,
  root,
  collisionArchives: collisionArchives.length,
  concurrentSessions: concurrentKeys.length,
  corruptCopies: corruptCopies.length,
  retainedArchives: retainedArchives.length,
  evidenceSecrets: Object.keys(secretValues).length,
  sameSessionTransactionRounds: 40,
  slugCollisionIsolation: 'pass',
  exactArchiveOwnership: 'pass',
  reservedSeparatorInvariant: 'pass',
  orphanArchiveCleanup: 'pass',
  indexRenameRollback: 'pass',
  indexedArchiveProtected: 'pass',
  postFloorTokenDelta: 'pass',
  highToSoftSuppression: 'pass',
  softToSoftDeltaSuppression: 'pass',
  observedDirectionalRecovery: 'pass',
  throttle: 'hard-floor-and-direction-pass',
  cleaned: true,
};
await fs.rm(root, { recursive: true, force: true });
try {
  await fs.access(root);
  throw new Error('successful resilience suite left its temporary tree behind');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(JSON.stringify(result));
