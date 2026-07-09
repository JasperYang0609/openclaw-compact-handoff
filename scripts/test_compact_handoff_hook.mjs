import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import handler from '../hooks/compact-handoff/handler.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-test-'));
const sessionFile = path.join(root, 'session.jsonl');
await fs.writeFile(sessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: '請幫我做 compact handoff MVP' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: '好的，我會新增 hook 並驗證。commit cca118c READY' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: `token: ${'A'.repeat(96)}` } }),
].join('\n'));

const baseEvent = {
  type: 'session',
  action: 'compact:before',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: { sessionId: 'test-session', sessionFile },
    messageCount: 2,
    tokenCount: 1234,
  },
};

await handler(baseEvent);
const current = path.join(root, 'memory/session_handoffs/session_agent:main:test.MEMORY.md');
const content = await fs.readFile(current, 'utf8');
if (!content.includes('Current Session Handoff') || !content.includes('compact handoff MVP')) {
  throw new Error('handoff content missing expected text');
}
if (!content.includes('Deterministic Working State')) {
  throw new Error('handoff missing deterministic working state');
}
if (content.includes('A'.repeat(40))) {
  throw new Error('handoff did not redact sensitive long-token content');
}

const bootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(bootstrapEvent);
if (!bootstrapEvent.context.bootstrapFiles.length) throw new Error('bootstrap injection failed');

const otherBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:other',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(otherBootstrapEvent);
if (otherBootstrapEvent.context.bootstrapFiles.length) throw new Error('cross-session handoff injection must not happen');

const earlyLowEvent = {
  type: 'message',
  action: 'preprocessed',
  sessionKey: 'agent:main:low',
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: { sessionId: 'low-session', sessionFile, totalTokens: 1000, contextTokens: 10000 },
  },
};
await handler(earlyLowEvent);
try {
  await fs.access(path.join(root, 'memory/session_handoffs/session_agent:main:low.MEMORY.md'));
  throw new Error('low-pressure session should not write early handoff');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const earlyHighEvent = {
  type: 'message',
  action: 'preprocessed',
  sessionKey: 'agent:main:high',
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: { sessionId: 'high-session', sessionFile, totalTokens: 7000, contextTokens: 10000 },
  },
};
await handler(earlyHighEvent);
const earlyPath = path.join(root, 'memory/session_handoffs/session_agent:main:high.MEMORY.md');
const earlyContent = await fs.readFile(earlyPath, 'utf8');
if (!earlyContent.includes('phase: early-handoff') || !earlyContent.includes('token-ratio-0.70')) {
  throw new Error('early handoff did not capture expected threshold metadata');
}

const indexPath = path.join(root, 'memory/session_handoffs/index.json');
const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
if (!index.sessions['agent:main:high'] || !index.sessions['agent:main:test']) {
  throw new Error('handoff index missing expected sessions');
}

console.log(JSON.stringify({
  ok: true,
  root,
  injected: bootstrapEvent.context.bootstrapFiles.length,
  otherInjected: otherBootstrapEvent.context.bootstrapFiles.length,
  earlyPhase: index.sessions['agent:main:high'].phase,
}));
