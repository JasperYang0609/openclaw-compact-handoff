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

const projectRoot = path.join(root, 'memory/project_states/demo-project');
await fs.mkdir(projectRoot, { recursive: true });
await fs.writeFile(path.join(root, 'memory/project_states/registry.json'), JSON.stringify({
  schema_version: 1,
  sessions: {
    'agent:main:test': {
      project: 'demo-project',
      registered_at: '2026-07-11T00:00:00+08:00',
      registered_by: 'test',
    },
  },
}, null, 2));
await fs.writeFile(path.join(projectRoot, 'ACTIVE_TASK_STATE.json'), JSON.stringify({
  schema_version: 1,
  state_seq: 3,
  project: 'demo-project',
  updated_at: '2026-07-11T00:00:00+08:00',
  updated_by: 'test',
  update_reason: 'fixture',
  current_mode: 'planning',
  active_task_id: null,
  task_title: null,
  owner: 'test',
  risk_level: 'none',
  requires_git_preflight: false,
  requires_branch: false,
  requires_migration_first: false,
  requires_jasper_approval: false,
  allowed_actions: ['read', 'plan', 'write_spec'],
  current_step: 'fixture current step',
  next_step: 'fixture next step',
  blockers: [],
  latest_artifacts: [],
  latest_commit: null,
  completion_probe: null,
  resume_instruction: 'Read demo project state before acting.',
}, null, 2));
await fs.writeFile(path.join(projectRoot, 'PROJECT_GATES.json'), JSON.stringify({
  schema_version: 1,
  project: 'demo-project',
  forbidden_actions: ['demo_forbidden_action_a', 'fake_canvas_push'],
  requires_approval_for: ['demo_approval_action'],
  approvals: [],
}, null, 2));

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
if (!content.includes('Project Recovery Pointer') || !content.includes('demo_forbidden_action_a')) {
  throw new Error('handoff missing project recovery pointer');
}
if (content.indexOf('Project Recovery Pointer') > content.indexOf('## Session Metadata')) {
  throw new Error('project recovery pointer must appear before session metadata');
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
if (bootstrapEvent.context.bootstrapFiles.length !== 2) throw new Error('bootstrap injection should include session handoff and project recovery');
const projectBootstrap = bootstrapEvent.context.bootstrapFiles.find((file) => file.name === 'PROJECT_RECOVERY.md');
if (!projectBootstrap || !projectBootstrap.content.includes('fake_canvas_push')) {
  throw new Error('project recovery bootstrap entry missing expected fixture content');
}
if (projectBootstrap.content.length > 4100) {
  throw new Error('project recovery bootstrap entry exceeded expected budget');
}

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

const unregisteredBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:high',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(unregisteredBootstrapEvent);
if (unregisteredBootstrapEvent.context.bootstrapFiles.length !== 1) {
  throw new Error('unregistered session with handoff should only inject the session MEMORY.md');
}
if (unregisteredBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('unregistered session must not inject project recovery');
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
  unregisteredInjected: unregisteredBootstrapEvent.context.bootstrapFiles.length,
  earlyPhase: index.sessions['agent:main:high'].phase,
}));
