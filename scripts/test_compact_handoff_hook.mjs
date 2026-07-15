import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import handler from '../hooks/compact-handoff/handler.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-test-'));

function assertUtf16Safe(text, label) {
  if (text.includes('\uFFFD')) throw new Error(`${label} contains U+FFFD`);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new Error(`${label} contains a dangling high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      throw new Error(`${label} contains a dangling low surrogate`);
    }
  }
}

const sessionFile = path.join(root, 'session.jsonl');
await fs.writeFile(sessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: '請幫我做 compact handoff MVP' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: '好的，我會新增 hook 並驗證。commit cca118c READY' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: `token: ${'A'.repeat(96)}` } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Approval request expired before a response was received.', metadata: { source: 'system', synthetic: true } } }),
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
if (!content.includes('- Latest Real User Request: 請幫我做 compact handoff MVP')) {
  throw new Error('synthetic metadata message replaced the latest real user request');
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
if (!/^- schemaVersion: 2$/m.test(content)) {
  throw new Error('handoff metadata missing schemaVersion 2');
}
const firstGenerationId = content.match(/^- generationId: (\S+)$/m)?.[1];
if (!firstGenerationId) {
  throw new Error('handoff metadata missing non-empty generationId');
}
await handler(baseEvent);
const regeneratedContent = await fs.readFile(current, 'utf8');
const secondGenerationId = regeneratedContent.match(/^- generationId: (\S+)$/m)?.[1];
if (!secondGenerationId || secondGenerationId === firstGenerationId) {
  throw new Error('each handoff generation must have a unique non-empty generationId');
}
if (regeneratedContent.includes('Operator Fill-in Checklist')) {
  throw new Error('handoff must not emit an empty operator fill-in template');
}

const unicodeSessionFile = path.join(root, 'unicode-session.jsonl');
await fs.writeFile(unicodeSessionFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: `UNICODE_EVIDENCE_界${'😀'.repeat(1600)}終` },
}));
const unicodeSessionKey = 'agent:main:unicode';
await handler({
  ...baseEvent,
  sessionKey: unicodeSessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'unicode-session', sessionFile: unicodeSessionFile },
  },
});
const unicodeContent = await fs.readFile(
  path.join(root, `memory/session_handoffs/session_${unicodeSessionKey}.MEMORY.md`),
  'utf8',
);
const unicodeEvidenceHeading = '### real_user\n';
const unicodeEvidenceStart = unicodeContent.lastIndexOf(unicodeEvidenceHeading) + unicodeEvidenceHeading.length;
const clippedUnicodeEvidence = unicodeContent.slice(unicodeEvidenceStart).trimEnd();
if (unicodeEvidenceStart < unicodeEvidenceHeading.length || clippedUnicodeEvidence.length > 1200) {
  throw new Error(`single evidence exceeded 1200-char hard cap: ${clippedUnicodeEvidence.length}`);
}
assertUtf16Safe(clippedUnicodeEvidence, 'single Unicode evidence');
assertUtf16Safe(unicodeContent, 'Unicode handoff');

const redactionExpansionSessionKey = 'agent:main:redaction-expansion';
const redactionExpansionSessionFile = path.join(root, 'redaction-expansion-session.jsonl');
await fs.writeFile(redactionExpansionSessionFile, JSON.stringify({
  type: 'message',
  message: { role: 'user', content: `REDACTION_EXPANSION_SENTINEL ${'token: x '.repeat(400)}` },
}));
await handler({
  ...baseEvent,
  sessionKey: redactionExpansionSessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'redaction-expansion-session', sessionFile: redactionExpansionSessionFile },
  },
});
const redactionExpansionContent = await fs.readFile(
  path.join(root, `memory/session_handoffs/session_${redactionExpansionSessionKey}.MEMORY.md`),
  'utf8',
);
const redactionEvidenceHeading = '### real_user\n';
const redactionEvidenceStart = redactionExpansionContent.lastIndexOf(redactionEvidenceHeading) + redactionEvidenceHeading.length;
const redactionExpandedEvidence = redactionExpansionContent.slice(redactionEvidenceStart).trimEnd();
if (redactionEvidenceStart < redactionEvidenceHeading.length || redactionExpandedEvidence.length > 1200) {
  throw new Error(`redaction-expanded evidence exceeded 1200-char hard cap: ${redactionExpandedEvidence.length}`);
}

const provenanceSessionFile = path.join(root, 'provenance-session.jsonl');
await fs.writeFile(provenanceSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Please help debug the Gateway timeout in my app.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Approval request apr-123 timed out before a response was received.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Pre-compaction memory flush. Store durable memories now.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: '[Async command completed] job-7 exited with code 0.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'Gateway notice: configuration reload completed.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'System notice: runtime maintenance completed.' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'System notice: this is pasted application output. Please diagnose it.' } }),
  JSON.stringify({ type: 'message', message: { role: 'tool', content: 'tool result payload' } }),
  JSON.stringify({ type: 'message', message: { role: 'developer', content: 'unclassified fixture payload' } }),
].join('\n'));
await handler({
  ...baseEvent,
  sessionKey: 'agent:main:provenance',
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'provenance-session', sessionFile: provenanceSessionFile },
  },
});
const provenanceContent = await fs.readFile(
  path.join(root, 'memory/session_handoffs/session_agent:main:provenance.MEMORY.md'),
  'utf8',
);
if (!provenanceContent.includes('- Latest Real User Request: System notice: this is pasted application output. Please diagnose it.')) {
  throw new Error('narrow synthetic recognizers discarded a genuine runtime-prefixed user request');
}
if ((provenanceContent.match(/^### synthetic_system$/gm) || []).length !== 5) {
  throw new Error('approval, memory-flush, async-command, Gateway, and System notices were not classified as synthetic_system');
}
if (!provenanceContent.includes('### tool_or_runtime\ntool result payload')) {
  throw new Error('tool transcript message was not classified as tool_or_runtime');
}
if (!provenanceContent.includes('### unknown\nunclassified fixture payload')) {
  throw new Error('unrecognized transcript role was not classified as unknown');
}

const priorityTailSessionKey = 'agent:main:priority-tail';
const priorityTailSessionFile = path.join(root, 'priority-tail-session.jsonl');
await fs.writeFile(priorityTailSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'PRIORITY_OLD_USER_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'PRIORITY_OLD_ASSISTANT_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'PRIORITY_REAL_USER_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'PRIORITY_ASSISTANT_STATUS_SENTINEL' } }),
  ...Array.from({ length: 24 }, (_, index) => JSON.stringify({
    type: 'message',
    metadata: { synthetic: true },
    message: { role: 'user', content: `System notice: synthetic tail ${index}.` },
  })),
].join('\n'));
await handler({
  ...baseEvent,
  sessionKey: priorityTailSessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'priority-tail-session', sessionFile: priorityTailSessionFile },
  },
});
const priorityTailContent = await fs.readFile(
  path.join(root, `memory/session_handoffs/session_${priorityTailSessionKey}.MEMORY.md`),
  'utf8',
);
if (!priorityTailContent.includes('- Latest Real User Request: PRIORITY_REAL_USER_SENTINEL')) {
  throw new Error('24-message synthetic tail displaced the latest real user request');
}
if (!priorityTailContent.includes('- Latest assistant-facing status: PRIORITY_ASSISTANT_STATUS_SENTINEL')) {
  throw new Error('24-message synthetic tail displaced the latest assistant status');
}
const priorityEvidenceHeadings = priorityTailContent.match(/^### /gm) || [];
if (priorityEvidenceHeadings.length !== 24) {
  throw new Error(`priority-tail evidence was not bounded to 24 entries: ${priorityEvidenceHeadings.length}`);
}
const priorityUserIndex = priorityTailContent.indexOf('### real_user\nPRIORITY_REAL_USER_SENTINEL');
const priorityAssistantIndex = priorityTailContent.indexOf('### assistant\nPRIORITY_ASSISTANT_STATUS_SENTINEL');
const firstRetainedSyntheticIndex = priorityTailContent.indexOf('### synthetic_system\nSystem notice: synthetic tail 2.');
const lastRetainedSyntheticIndex = priorityTailContent.indexOf('### synthetic_system\nSystem notice: synthetic tail 23.');
if (!(priorityUserIndex >= 0 && priorityUserIndex < priorityAssistantIndex && priorityAssistantIndex < firstRetainedSyntheticIndex && firstRetainedSyntheticIndex < lastRetainedSyntheticIndex)) {
  throw new Error('priority-tail evidence is not in chronological order');
}
if (priorityTailContent.includes('PRIORITY_OLD_USER_SENTINEL') || priorityTailContent.includes('PRIORITY_OLD_ASSISTANT_SENTINEL')) {
  throw new Error('priority-tail evidence retained displaced old priority messages');
}

const recursiveSessionKey = 'agent:main:recursive';
const recursiveCurrent = path.join(root, `memory/session_handoffs/session_${recursiveSessionKey}.MEMORY.md`);
await fs.writeFile(recursiveCurrent, '# Current Session Handoff — Compact Safe\nPREVIOUS_FILE_SENTINEL\n');
const recursiveSessionFile = path.join(root, 'recursive-session.jsonl');
await fs.writeFile(recursiveSessionFile, [
  JSON.stringify({ type: 'message', message: { role: 'user', content: '# Compact Handoff\nRECURSIVE_TRANSCRIPT_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: 'memory/session_handoffs/session_old.MEMORY.md\n# Current Session Handoff — Compact Safe\nSESSION_HANDOFF_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: '## memory/session_handoffs/session_framed.MEMORY.md\n\n# Current Session Handoff — Compact Safe\nFRAMED_SESSION_HANDOFF_SENTINEL' } }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: '[Compact Handoff Bootstrap]\nBOOTSTRAP_BLOCK_SENTINEL' } }),
].join('\n'));
await handler({
  ...baseEvent,
  sessionKey: recursiveSessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'recursive-session', sessionFile: recursiveSessionFile },
  },
});
const recursiveContent = await fs.readFile(recursiveCurrent, 'utf8');
for (const sentinel of [
  'PREVIOUS_FILE_SENTINEL',
  'RECURSIVE_TRANSCRIPT_SENTINEL',
  'SESSION_HANDOFF_SENTINEL',
  'FRAMED_SESSION_HANDOFF_SENTINEL',
  'BOOTSTRAP_BLOCK_SENTINEL',
]) {
  if (recursiveContent.includes(sentinel)) {
    throw new Error(`new handoff recursively copied ${sentinel}`);
  }
}
if (recursiveContent.includes('## Previous Handoff Snapshot')) {
  throw new Error('new handoff retained the recursive previous-handoff section');
}
if (recursiveContent.includes('Latest Real User Request:')) {
  throw new Error('synthetic-only transcript must omit Latest Real User Request');
}

const oversizedBodySessionKey = 'agent:main:oversized-body';
const oversizedBodySessionFile = path.join(root, 'oversized-body-session.jsonl');
const oversizedBulkMessages = Array.from({ length: 22 }, (_, index) => ({
  type: 'message',
  message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `BULK_EXTRACT_${index}_界${'😀'.repeat(900)}` },
}));
await fs.writeFile(oversizedBodySessionFile, [
  ...oversizedBulkMessages,
  { type: 'message', message: { role: 'user', content: `LATEST_REAL_USER_SENTINEL_界${'😀'.repeat(900)}` } },
  { type: 'message', message: { role: 'assistant', content: `LATEST_ASSISTANT_STATUS_SENTINEL_PASS_界${'😀'.repeat(900)}` } },
].map((entry) => JSON.stringify(entry)).join('\n'));
await handler({
  ...baseEvent,
  sessionKey: oversizedBodySessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'oversized-body-session', sessionFile: oversizedBodySessionFile },
  },
});
const oversizedBodyContent = await fs.readFile(
  path.join(root, `memory/session_handoffs/session_${oversizedBodySessionKey}.MEMORY.md`),
  'utf8',
);
if (oversizedBodyContent.length > 8000) {
  throw new Error(`handoff body exceeded 8000-char hard cap: ${oversizedBodyContent.length}`);
}
for (const required of [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  `- sessionKey: ${oversizedBodySessionKey}`,
  'LATEST_REAL_USER_SENTINEL',
  'LATEST_ASSISTANT_STATUS_SENTINEL_PASS',
]) {
  if (!oversizedBodyContent.includes(required)) {
    throw new Error(`budgeted handoff dropped priority content: ${required}`);
  }
}
const retainedBulkExtracts = oversizedBulkMessages.filter((_, index) => oversizedBodyContent.includes(`BULK_EXTRACT_${index}_`)).length;
if (retainedBulkExtracts === oversizedBulkMessages.length) {
  throw new Error('Recent Conversation Extract was not reduced before priority sections');
}
assertUtf16Safe(oversizedBodyContent, 'oversized handoff body');

const oversizedProjectSessionKey = 'agent:main:oversized-project';
const registryPath = path.join(root, 'memory/project_states/registry.json');
const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
registry.sessions[oversizedProjectSessionKey] = { project: 'oversized-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
const oversizedProjectRoot = path.join(root, 'memory/project_states/oversized-project');
await fs.mkdir(oversizedProjectRoot, { recursive: true });
await fs.writeFile(path.join(oversizedProjectRoot, 'ACTIVE_TASK_STATE.json'), JSON.stringify({
  current_mode: 'implementation',
  active_task_id: 'P1-A',
  task_title: 'Oversized UTF-16 budget fixture',
  risk_level: 'low',
  requires_jasper_approval: false,
  requires_migration_first: false,
  allowed_actions: Array.from({ length: 30 }, (_, index) => `allowed_ref_${String(index).padStart(2, '0')}/safe-path/${'allowed-segment/'.repeat(18)}`),
  current_step: `CURRENT_STEP_界${'😀'.repeat(2200)}`,
  next_step: `NEXT_STEP_界${'😀'.repeat(2200)}`,
  resume_instruction: `RESUME_界${'😀'.repeat(2200)}`,
}, null, 2));
await fs.writeFile(path.join(oversizedProjectRoot, 'PROJECT_GATES.json'), JSON.stringify({
  forbidden_actions: Array.from({ length: 30 }, (_, index) => `forbidden_ref_${String(index).padStart(2, '0')}/safe-path/${'forbidden-segment/'.repeat(16)}`),
}, null, 2));
await handler({
  ...baseEvent,
  sessionKey: oversizedProjectSessionKey,
  context: {
    ...baseEvent.context,
    sessionEntry: { sessionId: 'oversized-project-session', sessionFile },
  },
});
const oversizedProjectCurrent = path.join(
  root,
  `memory/session_handoffs/session_${oversizedProjectSessionKey}.MEMORY.md`,
);
const oversizedProjectHandoff = await fs.readFile(oversizedProjectCurrent, 'utf8');
const projectPointerSection = oversizedProjectHandoff.match(/## Project Recovery Pointer[\s\S]*?(?=\n\n## Session Metadata)/)?.[0];
if (!projectPointerSection || projectPointerSection.length > 2000) {
  throw new Error(`project pointer exceeded 2000-char hard cap: ${projectPointerSection?.length ?? 'missing'}`);
}
const retainedAllowedRefs = projectPointerSection.match(/allowed_ref_\d{2}/g) || [];
const retainedForbiddenRefs = projectPointerSection.match(/forbidden_ref_\d{2}/g) || [];
if (retainedAllowedRefs.length + retainedForbiddenRefs.length > 20) {
  throw new Error(`project pointer retained more than 20 aggregate exact references: ${retainedAllowedRefs.length + retainedForbiddenRefs.length}`);
}
if (!retainedAllowedRefs.length || !retainedForbiddenRefs.length) {
  throw new Error('project pointer aggregate cap must preserve both allowed and forbidden reference groups when both exist');
}
assertUtf16Safe(projectPointerSection, 'project pointer');
if (oversizedProjectHandoff.length > 8000) {
  throw new Error(`project-backed handoff exceeded 8000-char hard cap: ${oversizedProjectHandoff.length}`);
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
if (projectBootstrap.content.length > 2000) {
  throw new Error('project recovery bootstrap entry exceeded expected budget');
}
const sessionBootstrap = bootstrapEvent.context.bootstrapFiles.find((file) => file.path === current);
if (!sessionBootstrap || sessionBootstrap.content.length > 8000) {
  throw new Error(`session bootstrap exceeded 8000-char hard cap: ${sessionBootstrap?.content.length ?? 'missing'}`);
}
const customBootstrapChars = sessionBootstrap.content.length + projectBootstrap.content.length;
if (customBootstrapChars > 10000) {
  throw new Error(`combined compact-handoff bootstrap exceeded 10000-char hard cap: ${customBootstrapChars}`);
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

const legacyOversizedSessionKey = 'agent:main:legacy-oversized-bootstrap';
const legacyOversizedPath = path.join(
  root,
  `memory/session_handoffs/session_${legacyOversizedSessionKey}.MEMORY.md`,
);
await fs.writeFile(
  legacyOversizedPath,
  `# Legacy v1 Handoff\nLEGACY_OVERSIZED_SENTINEL_界${'😀'.repeat(9000)}`,
  'utf8',
);
const legacyOversizedBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: legacyOversizedSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(legacyOversizedBootstrapEvent);
const legacyBootstrap = legacyOversizedBootstrapEvent.context.bootstrapFiles.find(
  (file) => file.path === legacyOversizedPath,
);
if (!legacyBootstrap || legacyBootstrap.content.length > 8000) {
  throw new Error(`legacy oversized handoff was not capped at bootstrap: ${legacyBootstrap?.content.length ?? 'missing'}`);
}
assertUtf16Safe(legacyBootstrap.content, 'legacy oversized bootstrap');

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
