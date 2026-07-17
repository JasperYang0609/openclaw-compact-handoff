import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function safeSessionId(sessionKey, requestedSessionId) {
  if (typeof requestedSessionId === 'string'
      && requestedSessionId.length > 0
      && requestedSessionId.length <= 180
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestedSessionId)) {
    return requestedSessionId;
  }
  return `session-${createHash('sha256')
    .update(`${sessionKey}\u0000${String(requestedSessionId ?? '')}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

export async function createSessionAuthorityHarness(rawHandler, root) {
  process.env.HOME = root;
  const sessionsDir = path.join(root, '.openclaw', 'agents', 'main', 'sessions');
  const sessionsStorePath = path.join(sessionsDir, 'sessions.json');
  const sessions = {};
  let registrationQueue = Promise.resolve();
  let lastSessionsStoreText = '';
  await fs.mkdir(sessionsDir, { recursive: true });

  function canonicalSessionPath(sessionKey, requestedSessionId) {
    return path.join(sessionsDir, `${safeSessionId(sessionKey, requestedSessionId)}.jsonl`);
  }

  async function linkFixture(sourcePath, targetPath) {
    if (!sourcePath) return;
    const resolvedSource = path.resolve(sourcePath);
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedSource === resolvedTarget) return;
    try {
      const [sourceStat, targetStat] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)]);
      if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) return;
    } catch {
      // Missing target is the normal first-registration path.
    }
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.link(sourcePath, temporaryPath);
      await fs.rename(temporaryPath, targetPath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  async function registerSessionFixture(sessionKey, requestedSessionId, sessionFile, metadata = {}) {
    const sessionId = safeSessionId(sessionKey, requestedSessionId);
    const canonicalPath = canonicalSessionPath(sessionKey, sessionId);
    if (sessionFile) await linkFixture(sessionFile, canonicalPath);
    sessions[sessionKey] = {
      sessionId,
      ...(typeof metadata.totalTokens === 'number' ? { totalTokens: metadata.totalTokens } : {}),
      ...(typeof metadata.contextTokens === 'number' ? { contextTokens: metadata.contextTokens } : {}),
    };
    const serialized = `${JSON.stringify(sessions, null, 2)}\n`;
    if (serialized !== lastSessionsStoreText) {
      const temporaryStorePath = `${sessionsStorePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(temporaryStorePath, serialized, { mode: 0o600 });
        await fs.rename(temporaryStorePath, sessionsStorePath);
        lastSessionsStoreText = serialized;
      } finally {
        await fs.unlink(temporaryStorePath).catch(() => undefined);
      }
    }
    return { sessionId, sessionFile: sessionFile ? canonicalPath : undefined };
  }

  async function registerEvent(event) {
    const sessionKey = event?.sessionKey || event?.context?.sessionKey;
    const entry = event?.context?.sessionEntry || event?.context?.previousSessionEntry;
    if (typeof sessionKey !== 'string' || !entry || typeof entry !== 'object') return;
    const registered = await registerSessionFixture(
      sessionKey,
      entry.sessionId,
      entry.sessionFile,
      entry,
    );
    entry.sessionId = registered.sessionId;
    if (registered.sessionFile) entry.sessionFile = registered.sessionFile;
  }

  async function handler(event) {
    const registration = registrationQueue
      .catch(() => undefined)
      .then(() => registerEvent(event));
    registrationQueue = registration;
    await registration;
    return rawHandler(event);
  }

  return {
    handler,
    rawHandler,
    sessionsDir,
    sessionsStorePath,
    canonicalSessionPath,
    safeSessionId,
    registerSessionFixture: async (...args) => {
      const registration = registrationQueue
        .catch(() => undefined)
        .then(() => registerSessionFixture(...args));
      registrationQueue = registration;
      return registration;
    },
  };
}
