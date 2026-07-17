#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import rawHandler from '../hooks/compact-handoff/handler.ts';
import { createSessionAuthorityHarness } from './test_session_authority.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-resilience-'));
const sessionAuthority = await createSessionAuthorityHarness(rawHandler, root);
const { handler } = sessionAuthority;
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

// Independent module instances (or gateway processes) do not share the in-memory
// queue Map. Force both to read the same index snapshot and require lossless merge.
const isolatedKeys = [
  'agent:main:isolated-module-a',
  'agent:main:isolated-module-b',
];
const isolatedFiles = await Promise.all(isolatedKeys.map((_, index) => (
  writeTranscript(`isolated-module-${index}`, `isolated module request ${index}`)
)));
const isolatedAuthorities = await Promise.all(isolatedKeys.map((sessionKey, index) => (
  sessionAuthority.registerSessionFixture(
    sessionKey,
    `isolated-module-${index}-session`,
    isolatedFiles[index],
  )
)));
const isolatedEvents = isolatedKeys.map((sessionKey, index) => eventFor(
  sessionKey,
  'compact:before',
  isolatedAuthorities[index].sessionFile,
  {
    sessionId: isolatedAuthorities[index].sessionId,
    sessionFile: isolatedAuthorities[index].sessionFile,
  },
));
const isolatedModuleUrl = new URL('../hooks/compact-handoff/handler.ts', import.meta.url);
const [isolatedHandlerA, isolatedHandlerB] = await Promise.all([
  import(`${isolatedModuleUrl.href}?isolated=a-${Date.now()}`).then((module) => module.default),
  import(`${isolatedModuleUrl.href}?isolated=b-${Date.now()}`).then((module) => module.default),
]);
const originalOpenForIsolatedIndexRace = fs.open;
let isolatedIndexReadArrivals = 0;
let releaseIsolatedIndexReads;
const isolatedIndexReadBarrier = new Promise((resolve) => {
  releaseIsolatedIndexReads = resolve;
});
fs.open = async (target, ...args) => {
  const handle = await originalOpenForIsolatedIndexRace.call(fs, target, ...args);
  if (String(target) === indexPath) {
    const originalHandleRead = handle.read.bind(handle);
    let participated = false;
    handle.read = async (...readArgs) => {
      const result = await originalHandleRead(...readArgs);
      if (!participated) {
        participated = true;
        isolatedIndexReadArrivals += 1;
        if (isolatedIndexReadArrivals >= 2) releaseIsolatedIndexReads();
        await Promise.race([
          isolatedIndexReadBarrier,
          new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
      }
      return result;
    };
  }
  return handle;
};
try {
  await Promise.all([
    isolatedHandlerA(isolatedEvents[0]),
    isolatedHandlerB(isolatedEvents[1]),
  ]);
} finally {
  fs.open = originalOpenForIsolatedIndexRace;
}
const isolatedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
const missingIsolatedKeys = isolatedKeys.filter((sessionKey) => !isolatedIndex.sessions?.[sessionKey]);
if (isolatedIndexReadArrivals !== 2 || missingIsolatedKeys.length) {
  throw new Error(`independent handler instances lost shared index updates: ${JSON.stringify({
    isolatedIndexReadArrivals,
    missingIsolatedKeys,
  })}`);
}

const isolatedBootstrapKey = 'agent:main:isolated-bootstrap-one-shot';
const isolatedBootstrapCurrent = path.join(
  handoffDir,
  `session_${slug(isolatedBootstrapKey)}.MEMORY.md`,
);
const isolatedBootstrapState = path.join(
  handoffDir,
  `session_${slug(isolatedBootstrapKey)}.state.json`,
);
await fs.writeFile(isolatedBootstrapCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  `- generationId: ${fixtureUuid(900, '90000000')}`,
].join('\n'), { mode: 0o600 });
await fs.writeFile(isolatedBootstrapState, '{}\n', { mode: 0o600 });
const isolatedBootstrapEvents = [0, 1].map(() => ({
  type: 'agent',
  action: 'bootstrap',
  sessionKey: isolatedBootstrapKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
}));
const originalOpenForIsolatedBootstrapRace = fs.open;
let isolatedStateReadArrivals = 0;
let releaseIsolatedStateReads;
const isolatedStateReadBarrier = new Promise((resolve) => {
  releaseIsolatedStateReads = resolve;
});
fs.open = async (target, ...args) => {
  const handle = await originalOpenForIsolatedBootstrapRace.call(fs, target, ...args);
  if (String(target) === isolatedBootstrapState) {
    const originalHandleRead = handle.read.bind(handle);
    let participated = false;
    handle.read = async (...readArgs) => {
      const result = await originalHandleRead(...readArgs);
      if (!participated) {
        participated = true;
        isolatedStateReadArrivals += 1;
        if (isolatedStateReadArrivals >= 2) releaseIsolatedStateReads();
        await Promise.race([
          isolatedStateReadBarrier,
          new Promise((resolve) => setTimeout(resolve, 150)),
        ]);
      }
      return result;
    };
  }
  return handle;
};
try {
  await Promise.all([
    isolatedHandlerA(isolatedBootstrapEvents[0]),
    isolatedHandlerB(isolatedBootstrapEvents[1]),
  ]);
} finally {
  fs.open = originalOpenForIsolatedBootstrapRace;
}
const isolatedBootstrapInjections = isolatedBootstrapEvents.filter((event) => (
  event.context.bootstrapFiles.some((file) => file.path === isolatedBootstrapCurrent)
)).length;
if (isolatedStateReadArrivals !== 2 || isolatedBootstrapInjections !== 1) {
  throw new Error(`independent handler instances duplicated one-shot bootstrap injection: ${JSON.stringify({
    isolatedStateReadArrivals,
    isolatedBootstrapInjections,
  })}`);
}

// Exercise the same lifecycle lock through two real Node processes. The first
// process pauses after reading state; the second can reach that point only if
// the filesystem lock is absent. With the lock present, the first times out of
// the test barrier, commits, releases, and the second observes the committed
// one-shot record.
const crossProcessSessionKey = 'agent:main:cross-process-bootstrap';
const crossProcessCurrent = path.join(handoffDir, `session_${crossProcessSessionKey}.MEMORY.md`);
const crossProcessState = path.join(handoffDir, `session_${crossProcessSessionKey}.state.json`);
const crossProcessReadyDir = path.join(root, 'cross-process-ready');
await fs.mkdir(crossProcessReadyDir, { recursive: true });
await fs.writeFile(crossProcessCurrent, [
  '# Compact Handoff',
  '',
  'Generated: 2026-07-16 14:00:00 UTC',
  'Schema-Version: 2',
  `Generation-ID: ${randomUUID()}`,
  `Session-Key: ${crossProcessSessionKey}`,
  'Phase: after',
  '',
  '## Current Goal',
  'Cross-process one-shot lifecycle replay.',
].join('\n'), { mode: 0o600 });
await fs.writeFile(crossProcessState, '{}\n', { mode: 0o600 });

const childSource = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';

const statePath = process.env.CROSS_PROCESS_STATE;
const readyDir = process.env.CROSS_PROCESS_READY_DIR;
const childId = process.env.CROSS_PROCESS_CHILD_ID;
const originalOpen = fs.open;
let paused = false;
fs.open = async function patchedOpen(target, ...args) {
  const handle = await originalOpen.call(this, target, ...args);
  if (String(target) === statePath) {
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!paused) {
        paused = true;
        await fs.writeFile(path.join(readyDir, childId), 'ready');
        const deadline = Date.now() + 250;
        while (Date.now() < deadline) {
          const names = await fs.readdir(readyDir);
          if (names.includes('a') && names.includes('b')) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return result;
    };
  }
  return handle;
};

const { default: handler } = await import(process.env.CROSS_PROCESS_HANDLER_URL);
const event = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: process.env.CROSS_PROCESS_SESSION_KEY,
  context: {
    workspaceDir: process.env.CROSS_PROCESS_WORKSPACE,
    sessionKey: process.env.CROSS_PROCESS_SESSION_KEY,
    bootstrapFiles: [],
  },
};
await handler(event);
const injected = event.context.bootstrapFiles.filter((file) => file.path === process.env.CROSS_PROCESS_CURRENT).length;
process.stdout.write(JSON.stringify({ childId, injected }) + '\n');
`;

function runCrossProcessChild(childId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      env: {
        ...process.env,
        CROSS_PROCESS_CHILD_ID: childId,
        CROSS_PROCESS_CURRENT: crossProcessCurrent,
        CROSS_PROCESS_HANDLER_URL: new URL('../hooks/compact-handoff/handler.ts', import.meta.url).href,
        CROSS_PROCESS_READY_DIR: crossProcessReadyDir,
        CROSS_PROCESS_SESSION_KEY: crossProcessSessionKey,
        CROSS_PROCESS_STATE: crossProcessState,
        CROSS_PROCESS_WORKSPACE: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cross-process lifecycle child timed out: ${childId}`));
    }, 10000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`cross-process lifecycle child failed: ${JSON.stringify({ childId, code, stderr })}`));
        return;
      }
      try {
        const line = stdout.trim().split('\n').at(-1);
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`cross-process lifecycle child returned invalid output: ${JSON.stringify({ childId, stdout, stderr })}`, { cause: error }));
      }
    });
  });
}

const crossProcessResults = await Promise.all([
  runCrossProcessChild('a'),
  runCrossProcessChild('b'),
]);
const crossProcessBootstrapInjections = crossProcessResults
  .reduce((sum, result) => sum + Number(result.injected || 0), 0);
if (crossProcessBootstrapInjections !== 1) {
  throw new Error(`separate Node processes duplicated one-shot bootstrap injection: ${JSON.stringify(crossProcessResults)}`);
}

// A stale lock may be recovered only after its bounded metadata identifies a
// process that no longer exists. Recovery must then complete the real write and
// release the replacement lock.
const staleLockSessionKey = 'agent:main:stale-dead-owner-lock';
const staleLockPath = path.join(handoffDir, `.compact-handoff.session-${slug(staleLockSessionKey)}.lock`);
const staleLockTranscript = await writeTranscript('stale-dead-owner-lock');
const deadOwnerPid = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0 || !pid) reject(new Error(`dead-owner fixture child failed: ${code}`));
    else resolve(pid);
  });
});
await fs.writeFile(staleLockPath, `${JSON.stringify({ pid: deadOwnerPid, createdAtMs: 1 })}\n`, { mode: 0o600 });
const staleLockTime = new Date(Date.now() - 3 * 60 * 1000);
await fs.utimes(staleLockPath, staleLockTime, staleLockTime);
const originalOpenForStaleLock = fs.open;
const observedStaleLockOpenPaths = [];
fs.open = async (target, ...args) => {
  if (String(target).includes('.compact-handoff.') && String(target).endsWith('.lock')) {
    observedStaleLockOpenPaths.push(String(target));
  }
  return originalOpenForStaleLock.call(fs, target, ...args);
};
try {
  await handler(eventFor(staleLockSessionKey, 'compact:before', staleLockTranscript));
} finally {
  fs.open = originalOpenForStaleLock;
}
let staleLockRemained = true;
try {
  await fs.access(staleLockPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  staleLockRemained = false;
}
const staleLockCurrent = path.join(handoffDir, `session_${slug(staleLockSessionKey)}.MEMORY.md`);
if (staleLockRemained || !(await fs.readFile(staleLockCurrent, 'utf8')).includes(staleLockSessionKey)) {
  throw new Error(`dead-owner stale filesystem lock did not recover safely: ${JSON.stringify({
    staleLockPath,
    staleLockRemained,
    observedStaleLockOpenPaths,
  })}`);
}

// Two stale-lock reapers must not both retire the same observed inode. This
// fixture imports two real copies of the production helper and changes only the
// scheduling immediately before stale retirement: reaper B is paused until
// reaper A has acquired the successor lock and entered its protected task.
const lockRaceSourcePath = new URL('../hooks/compact-handoff/handler.ts', import.meta.url);
const lockRaceSource = await fs.readFile(lockRaceSourcePath, 'utf8');
const staleRetireNeedle = '          await fs.unlink(lockPath).catch((unlinkError: any) => {';
if (lockRaceSource.split(staleRetireNeedle).length !== 2) {
  throw new Error('stale-recovery race fixture could not locate the unique retirement boundary');
}
const instrumentedLockRaceSource = `${lockRaceSource.replace(
  staleRetireNeedle,
  `          await globalThis.__compactHandoffBeforeStaleRetire?.(lockPath);\n${staleRetireNeedle}`,
)}\nexport { withFilesystemLock };\n`;
const lockRaceModuleAPath = path.join(root, 'lock-race-handler-a.ts');
const lockRaceModuleBPath = path.join(root, 'lock-race-handler-b.ts');
await fs.writeFile(lockRaceModuleAPath, instrumentedLockRaceSource, { mode: 0o600 });
await fs.writeFile(lockRaceModuleBPath, instrumentedLockRaceSource, { mode: 0o600 });
const [{ withFilesystemLock: withLockA }, { withFilesystemLock: withLockB }] = await Promise.all([
  import(`${pathToFileURL(lockRaceModuleAPath).href}?copy=a`),
  import(`${pathToFileURL(lockRaceModuleBPath).href}?copy=b`),
]);
const staleRecoveryRaceLock = path.join(handoffDir, '.compact-handoff.stale-recovery-race.lock');
await fs.writeFile(
  staleRecoveryRaceLock,
  `${JSON.stringify({ pid: deadOwnerPid, createdAtMs: 1 })}\n`,
  { mode: 0o600 },
);
await fs.utimes(staleRecoveryRaceLock, staleLockTime, staleLockTime);
let staleRetireArrivals = 0;
let resolveSecondStaleRetire;
const secondStaleRetire = new Promise((resolve) => { resolveSecondStaleRetire = resolve; });
let releaseSecondStaleRetire;
const secondStaleRetireRelease = new Promise((resolve) => { releaseSecondStaleRetire = resolve; });
let resolveFirstProtectedTask;
const firstProtectedTask = new Promise((resolve) => { resolveFirstProtectedTask = resolve; });
let activeProtectedTasks = 0;
let maxActiveProtectedTasks = 0;
let protectedTaskEntries = 0;
const protectedTask = async () => {
  activeProtectedTasks += 1;
  maxActiveProtectedTasks = Math.max(maxActiveProtectedTasks, activeProtectedTasks);
  protectedTaskEntries += 1;
  if (protectedTaskEntries === 1) resolveFirstProtectedTask();
  await new Promise((resolve) => setTimeout(resolve, protectedTaskEntries === 1 ? 300 : 20));
  activeProtectedTasks -= 1;
};
const previousStaleRetireHook = globalThis.__compactHandoffBeforeStaleRetire;
globalThis.__compactHandoffBeforeStaleRetire = async (target) => {
  if (target !== staleRecoveryRaceLock) return;
  staleRetireArrivals += 1;
  if (staleRetireArrivals === 1) {
    await Promise.race([
      secondStaleRetire,
      new Promise((resolve) => setTimeout(resolve, 200)),
    ]);
  } else if (staleRetireArrivals === 2) {
    resolveSecondStaleRetire();
    await secondStaleRetireRelease;
  }
};
try {
  const lockAttempts = [
    withLockA(staleRecoveryRaceLock, protectedTask),
    withLockB(staleRecoveryRaceLock, protectedTask),
  ];
  await Promise.race([
    firstProtectedTask,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('stale-recovery race fixture never entered the first protected task')),
      2000,
    )),
  ]);
  releaseSecondStaleRetire();
  await Promise.all(lockAttempts);
} finally {
  globalThis.__compactHandoffBeforeStaleRetire = previousStaleRetireHook;
  await fs.unlink(staleRecoveryRaceLock).catch(() => undefined);
  await fs.unlink(`${staleRecoveryRaceLock}.recovery`).catch(() => undefined);
}
if (maxActiveProtectedTasks !== 1 || protectedTaskEntries !== 2) {
  throw new Error(`concurrent stale recovery violated filesystem-lock exclusion: ${JSON.stringify({
    maxActiveProtectedTasks,
    protectedTaskEntries,
    staleRetireArrivals,
  })}`);
}

// If the elected reaper itself dies, its recovery marker is not safe to
// reclaim with another pathname race. Preserve it and fail this attempt closed
// until an operator verifies and removes the marker.
const interruptedRecoveryKey = 'agent:main:interrupted-lock-recovery';
const interruptedRecoveryLock = path.join(
  handoffDir,
  `.compact-handoff.session-${slug(interruptedRecoveryKey)}.lock`,
);
const interruptedRecoveryMarker = `${interruptedRecoveryLock}.recovery`;
const interruptedRecoveryBytes = `${JSON.stringify({
  pid: deadOwnerPid,
  createdAtMs: 1,
  targetDev: 1,
  targetIno: 1,
})}\n`;
await fs.writeFile(interruptedRecoveryMarker, interruptedRecoveryBytes, { mode: 0o600 });
await fs.utimes(interruptedRecoveryMarker, staleLockTime, staleLockTime);
const interruptedRecoveryTranscript = await writeTranscript('interrupted-lock-recovery');
await handler(eventFor(interruptedRecoveryKey, 'compact:before', interruptedRecoveryTranscript));
const interruptedRecoveryCurrent = path.join(
  handoffDir,
  `session_${slug(interruptedRecoveryKey)}.MEMORY.md`,
);
let interruptedRecoveryCreatedOutput = false;
for (const candidate of [interruptedRecoveryLock, interruptedRecoveryCurrent]) {
  try {
    await fs.access(candidate);
    interruptedRecoveryCreatedOutput = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
if (interruptedRecoveryCreatedOutput
    || await fs.readFile(interruptedRecoveryMarker, 'utf8') !== interruptedRecoveryBytes) {
  throw new Error('interrupted stale recovery did not preserve its marker and fail closed');
}
await fs.unlink(interruptedRecoveryMarker);

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

// Failure while atomically replacing current must preserve the prior current/index and remove the new archive.
const currentWriteFailureFile = await writeTranscript('current-write-failure', 'current write failure request');
const currentWriteIndexBeforeRaw = await fs.readFile(indexPath, 'utf8');
const currentWriteIndexBefore = JSON.parse(currentWriteIndexBeforeRaw);
const currentWriteEntryBefore = structuredClone(currentWriteIndexBefore.sessions[malformedShapeKey]);
const currentWriteContentBefore = await fs.readFile(currentWriteEntryBefore.currentPath, 'utf8');
const currentWriteArchivesBefore = await archiveNames(malformedShapeKey, 'before');
const originalRenameForCurrentWriteFailure = fs.rename;
let currentWriteFailureInjected = false;
fs.rename = async (source, destination) => {
  if (destination === currentWriteEntryBefore.currentPath) {
    currentWriteFailureInjected = true;
    throw Object.assign(new Error('injected current handoff rename failure'), { code: 'EIO' });
  }
  return originalRenameForCurrentWriteFailure(source, destination);
};
try {
  await handler(eventFor(malformedShapeKey, 'compact:before', currentWriteFailureFile));
} finally {
  fs.rename = originalRenameForCurrentWriteFailure;
}
if (!currentWriteFailureInjected) {
  throw new Error('current write failure fixture did not reach the intended atomic rename');
}
const currentWriteIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
if (currentWriteIndexAfterRaw !== currentWriteIndexBeforeRaw) {
  throw new Error('failed current handoff write changed the live index');
}
const currentWriteContentAfter = await fs.readFile(currentWriteEntryBefore.currentPath, 'utf8');
if (currentWriteContentAfter !== currentWriteContentBefore) {
  throw new Error('failed current handoff write changed the prior live current content');
}
const currentWriteArchivesAfter = await archiveNames(malformedShapeKey, 'before');
if (currentWriteArchivesAfter.length !== currentWriteArchivesBefore.length) {
  throw new Error('failed current handoff write left an uncommitted archive');
}

// Index rewrites must discard arbitrary root/session properties instead of reserializing attacker data.
const indexAllowlistSecret = 'P1C_INDEX_UNKNOWN_SECRET_MUST_NOT_PERSIST';
const indexBeforeAllowlist = JSON.parse(await fs.readFile(indexPath, 'utf8'));
indexBeforeAllowlist.unknownRootSecret = indexAllowlistSecret;
indexBeforeAllowlist.sessions[malformedShapeKey].unknownEntrySecret = indexAllowlistSecret;
await fs.writeFile(indexPath, `${JSON.stringify(indexBeforeAllowlist, null, 2)}\n`, { mode: 0o600 });
const indexAllowlistKey = 'agent:main:index-allowlist';
const indexAllowlistFile = await writeTranscript('index-allowlist');
await handler(eventFor(indexAllowlistKey, 'compact:before', indexAllowlistFile));
const indexAfterAllowlistRaw = await fs.readFile(indexPath, 'utf8');
const indexAfterAllowlist = JSON.parse(indexAfterAllowlistRaw);
if (indexAfterAllowlistRaw.includes(indexAllowlistSecret)
    || Object.keys(indexAfterAllowlist).some((key) => key !== 'sessions')) {
  throw new Error('index update reserialized arbitrary secret-bearing root/session properties');
}

// Oversized index content must be rejected from opened-handle metadata before
// any content read, and the failed transaction must leave no current/archive.
const oversizedIndexKey = 'agent:main:index-oversized';
const oversizedIndexFile = await writeTranscript('index-oversized');
const oversizedIndexBeforeRaw = await fs.readFile(indexPath, 'utf8');
const oversizedIndexPayload = `${JSON.stringify({ sessions: {}, padding: 'x'.repeat(512 * 1024) })}\n`;
const oversizedIndexArchivesBefore = await archiveNames(oversizedIndexKey, 'before');
const oversizedIndexCurrent = path.join(handoffDir, `session_${slug(oversizedIndexKey)}.MEMORY.md`);
await fs.writeFile(indexPath, oversizedIndexPayload, { mode: 0o600 });
const originalOpenForOversizedIndex = fs.open;
let oversizedIndexReadCount = 0;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForOversizedIndex.call(fs, target, ...args);
  if (String(target) === indexPath) {
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      oversizedIndexReadCount += 1;
      return originalRead(...readArgs);
    };
  }
  return handle;
};
try {
  await handler(eventFor(oversizedIndexKey, 'compact:before', oversizedIndexFile));
} finally {
  fs.open = originalOpenForOversizedIndex;
}
const oversizedIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
const oversizedIndexArchivesAfter = await archiveNames(oversizedIndexKey, 'before');
let oversizedIndexCurrentExists = true;
try {
  await fs.access(oversizedIndexCurrent);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  oversizedIndexCurrentExists = false;
}
await fs.writeFile(indexPath, oversizedIndexBeforeRaw, { mode: 0o600 });
if (oversizedIndexReadCount !== 0
    || oversizedIndexAfterRaw !== oversizedIndexPayload
    || oversizedIndexArchivesAfter.length !== oversizedIndexArchivesBefore.length
    || oversizedIndexCurrentExists) {
  throw new Error(`oversized index was read or partially committed before the 512 KiB bound rejected it: ${JSON.stringify({
    oversizedIndexReadCount,
    indexUnchanged: oversizedIndexAfterRaw === oversizedIndexPayload,
    archiveDelta: oversizedIndexArchivesAfter.length - oversizedIndexArchivesBefore.length,
    oversizedIndexCurrentExists,
  })}`);
}

// The live index must be read through a bounded O_NOFOLLOW opened handle.
const indexSymlinkKey = 'agent:main:index-symlink';
const indexSymlinkFile = await writeTranscript('index-symlink');
const indexSymlinkTarget = path.join(root, 'index-symlink-target.json');
const indexSymlinkBackup = `${indexPath}.pre-symlink`;
const indexSymlinkSecret = 'P1C_INDEX_SYMLINK_TARGET_SECRET';
const indexBeforeSymlinkRaw = await fs.readFile(indexPath, 'utf8');
await fs.writeFile(indexSymlinkTarget, `${JSON.stringify({
  unknownRootSecret: indexSymlinkSecret,
  sessions: JSON.parse(indexBeforeSymlinkRaw).sessions,
}, null, 2)}\n`, { mode: 0o600 });
const indexSymlinkTargetBefore = await fs.readFile(indexSymlinkTarget, 'utf8');
const indexSymlinkArchivesBefore = await archiveNames(indexSymlinkKey, 'before');
await fs.rename(indexPath, indexSymlinkBackup);
await fs.symlink(indexSymlinkTarget, indexPath);
await handler(eventFor(indexSymlinkKey, 'compact:before', indexSymlinkFile));
const indexRemainedSymlink = (await fs.lstat(indexPath)).isSymbolicLink();
const indexSymlinkTargetAfter = await fs.readFile(indexSymlinkTarget, 'utf8');
const indexSymlinkArchivesAfter = await archiveNames(indexSymlinkKey, 'before');
await fs.unlink(indexPath);
await fs.rename(indexSymlinkBackup, indexPath);
await fs.unlink(indexSymlinkTarget);
for (const name of indexSymlinkArchivesAfter) {
  if (!indexSymlinkArchivesBefore.includes(name)) await fs.unlink(path.join(handoffDir, name)).catch(() => undefined);
}
await fs.unlink(path.join(handoffDir, `session_${slug(indexSymlinkKey)}.MEMORY.md`)).catch(() => undefined);
if (!indexRemainedSymlink
    || indexSymlinkTargetAfter !== indexSymlinkTargetBefore
    || indexSymlinkArchivesAfter.length !== indexSymlinkArchivesBefore.length) {
  throw new Error('index symlink was followed or replaced instead of failing closed');
}

// Snapshotting a prior current handoff must also be bounded and no-follow.
const safeSnapshotIndexRaw = await fs.readFile(indexPath, 'utf8');
const safeSnapshotIndex = JSON.parse(safeSnapshotIndexRaw);
const safeSnapshotEntry = structuredClone(safeSnapshotIndex.sessions[malformedShapeKey]);
const safeSnapshotCurrent = safeSnapshotEntry.currentPath;
const safeSnapshotBackup = `${safeSnapshotCurrent}.pre-symlink`;
const safeSnapshotVictim = path.join(root, 'current-snapshot-symlink-target.md');
const safeSnapshotVictimSecret = 'P1C_CURRENT_SNAPSHOT_SYMLINK_SECRET';
const safeSnapshotArchivesBefore = await archiveNames(malformedShapeKey, 'before');
await fs.writeFile(safeSnapshotVictim, safeSnapshotVictimSecret, { mode: 0o600 });
await fs.rename(safeSnapshotCurrent, safeSnapshotBackup);
await fs.symlink(safeSnapshotVictim, safeSnapshotCurrent);
const safeSnapshotFile = await writeTranscript('current-snapshot-symlink');
await handler(eventFor(malformedShapeKey, 'compact:before', safeSnapshotFile));
const currentRemainedSymlink = (await fs.lstat(safeSnapshotCurrent)).isSymbolicLink();
const safeSnapshotVictimAfter = await fs.readFile(safeSnapshotVictim, 'utf8');
const safeSnapshotIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
const safeSnapshotArchivesAfter = await archiveNames(malformedShapeKey, 'before');
await fs.rm(safeSnapshotCurrent, { force: true });
await fs.rename(safeSnapshotBackup, safeSnapshotCurrent);
await fs.writeFile(indexPath, safeSnapshotIndexRaw, { mode: 0o600 });
await fs.unlink(safeSnapshotVictim);
for (const name of safeSnapshotArchivesAfter) {
  if (!safeSnapshotArchivesBefore.includes(name)) await fs.unlink(path.join(handoffDir, name)).catch(() => undefined);
}
if (!currentRemainedSymlink
    || safeSnapshotVictimAfter !== safeSnapshotVictimSecret
    || safeSnapshotIndexAfterRaw !== safeSnapshotIndexRaw
    || safeSnapshotArchivesAfter.length !== safeSnapshotArchivesBefore.length) {
  throw new Error('current rollback snapshot followed or replaced a symlink');
}

// If index commit and current rollback both fail, retain evidence and block bootstrap with a pending marker.
const rollbackFailureIndexBeforeRaw = await fs.readFile(indexPath, 'utf8');
const rollbackFailureIndexBefore = JSON.parse(rollbackFailureIndexBeforeRaw);
const rollbackFailureEntry = structuredClone(rollbackFailureIndexBefore.sessions[malformedShapeKey]);
const rollbackFailureCurrent = rollbackFailureEntry.currentPath;
const rollbackFailureCurrentBefore = await fs.readFile(rollbackFailureCurrent, 'utf8');
const rollbackFailureArchivesBefore = await archiveNames(malformedShapeKey, 'before');
const rollbackFailureFile = await writeTranscript('current-rollback-failure', 'rollback must remain fail closed');
const rollbackFailureMarker = `${rollbackFailureCurrent}.pending`;
const originalRenameForRollbackFailure = fs.rename;
let rollbackFailureCurrentRenames = 0;
let rollbackFailureIndexInjected = false;
let rollbackFailureRestoreInjected = false;
fs.rename = async (source, destination) => {
  if (destination === rollbackFailureCurrent) {
    rollbackFailureCurrentRenames += 1;
    if (rollbackFailureCurrentRenames >= 2) {
      rollbackFailureRestoreInjected = true;
      throw Object.assign(new Error('injected current rollback failure'), { code: 'EIO' });
    }
  }
  if (destination === indexPath) {
    rollbackFailureIndexInjected = true;
    throw Object.assign(new Error('injected index commit failure before rollback'), { code: 'EIO' });
  }
  return originalRenameForRollbackFailure(source, destination);
};
try {
  await handler(eventFor(malformedShapeKey, 'compact:before', rollbackFailureFile));
} finally {
  fs.rename = originalRenameForRollbackFailure;
}
const rollbackFailureIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
const rollbackFailureCurrentAfter = await fs.readFile(rollbackFailureCurrent, 'utf8');
const rollbackFailureArchivesAfter = await archiveNames(malformedShapeKey, 'before');
let rollbackFailureMarkerExists = true;
await fs.access(rollbackFailureMarker).catch(() => { rollbackFailureMarkerExists = false; });
const rollbackFailureBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: malformedShapeKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: rollbackFailureCurrent, content: 'PRELOADED_UNCOMMITTED_CURRENT', missing: false }],
  },
};
await handler(rollbackFailureBootstrapEvent);
const rollbackFailureInjected = rollbackFailureBootstrapEvent.context.bootstrapFiles.some(
  (file) => file.path === rollbackFailureCurrent,
);
await fs.writeFile(rollbackFailureCurrent, rollbackFailureCurrentBefore, { mode: 0o600 });
await fs.writeFile(indexPath, rollbackFailureIndexBeforeRaw, { mode: 0o600 });
await fs.unlink(rollbackFailureMarker).catch(() => undefined);
for (const name of rollbackFailureArchivesAfter) {
  if (!rollbackFailureArchivesBefore.includes(name)) await fs.unlink(path.join(handoffDir, name)).catch(() => undefined);
}
if (!rollbackFailureIndexInjected
    || !rollbackFailureRestoreInjected
    || rollbackFailureIndexAfterRaw !== rollbackFailureIndexBeforeRaw
    || generationId(rollbackFailureCurrentAfter) === generationId(rollbackFailureCurrentBefore)
    || !rollbackFailureMarkerExists
    || rollbackFailureArchivesAfter.length !== rollbackFailureArchivesBefore.length + 1
    || rollbackFailureInjected) {
  throw new Error(`failed current rollback was not durably fail-closed: ${JSON.stringify({
    rollbackFailureIndexInjected,
    rollbackFailureRestoreInjected,
    rollbackFailureMarkerExists,
    archiveDelta: rollbackFailureArchivesAfter.length - rollbackFailureArchivesBefore.length,
    rollbackFailureInjected,
  })}`);
}

// An unresolved marker is durable mismatch evidence. A later transaction must
// not overwrite or clear it, even if that later write could otherwise succeed.
const unresolvedPendingKey = 'agent:main:unresolved-pending-marker';
const unresolvedPendingInitialFile = await writeTranscript(
  'unresolved-pending-initial',
  'establish initial pending-marker generation',
);
await handler(eventFor(unresolvedPendingKey, 'compact:before', unresolvedPendingInitialFile));
const unresolvedPendingIndexBeforeRaw = await fs.readFile(indexPath, 'utf8');
const unresolvedPendingIndexBefore = JSON.parse(unresolvedPendingIndexBeforeRaw);
const unresolvedPendingCurrent = unresolvedPendingIndexBefore.sessions[unresolvedPendingKey].currentPath;
const unresolvedPendingCurrentBefore = await fs.readFile(unresolvedPendingCurrent, 'utf8');
const unresolvedPendingArchivesBefore = await archiveNames(unresolvedPendingKey, 'before');
const unresolvedPendingMarker = `${unresolvedPendingCurrent}.pending`;
const unresolvedPendingMarkerBytes = `${JSON.stringify({
  schemaVersion: 1,
  current: path.basename(unresolvedPendingCurrent),
  createdAt: '2000-01-01T00:00:00',
  unresolved: true,
})}\n`;
await fs.writeFile(unresolvedPendingMarker, unresolvedPendingMarkerBytes, { mode: 0o600 });
const unresolvedPendingNextFile = await writeTranscript(
  'unresolved-pending-next',
  'must not overwrite unresolved pending marker',
);
await handler(eventFor(unresolvedPendingKey, 'compact:before', unresolvedPendingNextFile));
const unresolvedPendingIndexAfterRaw = await fs.readFile(indexPath, 'utf8');
const unresolvedPendingCurrentAfter = await fs.readFile(unresolvedPendingCurrent, 'utf8');
const unresolvedPendingArchivesAfter = await archiveNames(unresolvedPendingKey, 'before');
const unresolvedPendingMarkerAfter = await fs.readFile(unresolvedPendingMarker, 'utf8').catch(
  (error) => (error?.code === 'ENOENT' ? undefined : Promise.reject(error)),
);
const unresolvedPendingBootstrap = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: unresolvedPendingKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: unresolvedPendingCurrent,
      content: 'PRELOADED_UNRESOLVED_PENDING_CURRENT',
      missing: false,
    }],
  },
};
await handler(unresolvedPendingBootstrap);
const unresolvedPendingInjected = unresolvedPendingBootstrap.context.bootstrapFiles.some(
  (file) => file.path === unresolvedPendingCurrent,
);
await fs.writeFile(indexPath, unresolvedPendingIndexBeforeRaw, { mode: 0o600 });
await fs.writeFile(unresolvedPendingCurrent, unresolvedPendingCurrentBefore, { mode: 0o600 });
await fs.unlink(unresolvedPendingMarker).catch(() => undefined);
for (const name of unresolvedPendingArchivesAfter) {
  if (!unresolvedPendingArchivesBefore.includes(name)) {
    await fs.unlink(path.join(handoffDir, name)).catch(() => undefined);
  }
}
if (unresolvedPendingMarkerAfter !== unresolvedPendingMarkerBytes
    || unresolvedPendingIndexAfterRaw !== unresolvedPendingIndexBeforeRaw
    || unresolvedPendingCurrentAfter !== unresolvedPendingCurrentBefore
    || unresolvedPendingArchivesAfter.length !== unresolvedPendingArchivesBefore.length
    || unresolvedPendingInjected) {
  throw new Error(`pre-existing pending marker was overwritten or cleared by a later transaction: ${JSON.stringify({
    markerPreserved: unresolvedPendingMarkerAfter === unresolvedPendingMarkerBytes,
    indexPreserved: unresolvedPendingIndexAfterRaw === unresolvedPendingIndexBeforeRaw,
    currentPreserved: unresolvedPendingCurrentAfter === unresolvedPendingCurrentBefore,
    archiveDelta: unresolvedPendingArchivesAfter.length - unresolvedPendingArchivesBefore.length,
    bootstrapBlocked: !unresolvedPendingInjected,
  })}`);
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
  snowflake: '111111111111111111',
  commit: '0123456789abcdef0123456789abcdef01234567',
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
  crossProcessBootstrapInjections,
  corruptCopies: corruptCopies.length,
  retainedArchives: retainedArchives.length,
  evidenceSecrets: Object.keys(secretValues).length,
  sameSessionTransactionRounds: 40,
  slugCollisionIsolation: 'pass',
  exactArchiveOwnership: 'pass',
  reservedSeparatorInvariant: 'pass',
  orphanArchiveCleanup: 'pass',
  indexRenameRollback: 'pass',
  currentWriteFailureRollback: 'pass',
  preexistingPendingMarker: 'fail-closed-pass',
  sharedFilesystemLocks: 'module-and-child-process-pass',
  staleDeadOwnerLockRecovery: 'pass',
  concurrentStaleRecoveryExclusion: 'pass',
  interruptedRecoveryMarker: 'fail-closed-pass',
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
