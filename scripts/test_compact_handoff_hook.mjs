import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import rawHandler from '../hooks/compact-handoff/handler.ts';
import { createSessionAuthorityHarness } from './test_session_authority.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-handoff-test-'));
const sessionAuthority = await createSessionAuthorityHarness(rawHandler, root);
const { handler } = sessionAuthority;

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

function corruptStateArtifactPath(statePath, index, namespace = 0) {
  const serial = namespace + index;
  const uuid = `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`;
  return `${statePath}.corrupt-${1700000000000 + serial}-${1000 + serial}-${uuid}`;
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
const lifecycleStatePath = path.join(root, 'memory/session_handoffs/session_agent:main:test.state.json');
let lifecycleState = {};
try {
  lifecycleState = JSON.parse(await fs.readFile(lifecycleStatePath, 'utf8'));
} catch {}
if (lifecycleState.injection?.generationId !== secondGenerationId
    || lifecycleState.injection?.attempts !== 1
    || lifecycleState.injection?.consumed !== false
    || lifecycleState.injection?.status !== 'injected-once-unconfirmed'
    || lifecycleState.injection?.mode !== 'single-bootstrap-no-delivery-correlation') {
  throw new Error('bootstrap did not persist the degraded one-shot injection lifecycle');
}
const repeatedBootstrapEvent = {
  ...bootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(repeatedBootstrapEvent);
if (repeatedBootstrapEvent.context.bootstrapFiles.some((file) => file.path === current)) {
  throw new Error('the same handoff generation was injected more than once');
}
if (!repeatedBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('one-shot session lifecycle must not suppress the independent project recovery pointer');
}

const stateReadFailureSessionKey = 'agent:main:state-read-failure';
const stateReadFailureCurrent = path.join(
  root,
  `memory/session_handoffs/session_${stateReadFailureSessionKey}.MEMORY.md`,
);
const stateReadFailureState = path.join(
  root,
  `memory/session_handoffs/session_${stateReadFailureSessionKey}.state.json`,
);
registry.sessions[stateReadFailureSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(stateReadFailureCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e1',
].join('\n'));
const originalOpenForStateFailure = fs.open;
const injectedStateReadFailure = Object.assign(new Error('injected lifecycle state read EACCES'), { code: 'EACCES' });
fs.open = async (target, ...args) => {
  if (String(target) === stateReadFailureState) throw injectedStateReadFailure;
  return originalOpenForStateFailure.call(fs, target, ...args);
};
const stateReadFailureBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: stateReadFailureSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: stateReadFailureCurrent,
      content: 'PRELOADED_STATE_READ_FAILURE_SENTINEL',
      missing: false,
    }],
  },
};
try {
  await handler(stateReadFailureBootstrapEvent);
} finally {
  fs.open = originalOpenForStateFailure;
}
if (stateReadFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.path === stateReadFailureCurrent)) {
  throw new Error('lifecycle state read I/O failure left a preloaded untracked session handoff');
}
if (!stateReadFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('lifecycle state read I/O failure suppressed independent project recovery');
}

const currentReadFailureSessionKey = 'agent:main:current-read-failure';
const currentReadFailureCurrent = path.join(
  root,
  `memory/session_handoffs/session_${currentReadFailureSessionKey}.MEMORY.md`,
);
registry.sessions[currentReadFailureSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(currentReadFailureCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000c1',
].join('\n'));
const originalOpenForCurrentReadFailure = fs.open;
fs.open = async (target, ...args) => {
  if (String(target) === currentReadFailureCurrent) {
    throw Object.assign(new Error('injected current handoff read EIO'), { code: 'EIO' });
  }
  return originalOpenForCurrentReadFailure.call(fs, target, ...args);
};
const currentReadFailureBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: currentReadFailureSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: currentReadFailureCurrent,
      content: 'PRELOADED_CURRENT_READ_FAILURE_SENTINEL',
      missing: false,
    }],
  },
};
try {
  await handler(currentReadFailureBootstrapEvent);
} finally {
  fs.open = originalOpenForCurrentReadFailure;
}
if (currentReadFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.path === currentReadFailureCurrent)) {
  throw new Error('current handoff read I/O failure left a preloaded untracked session handoff');
}
if (!currentReadFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('current handoff read I/O failure suppressed independent project recovery');
}

const unsafeCurrentSessionKey = 'agent:main:unsafe-current-mode';
const unsafeCurrentPath = path.join(root, `memory/session_handoffs/session_${unsafeCurrentSessionKey}.MEMORY.md`);
registry.sessions[unsafeCurrentSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(unsafeCurrentPath, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000c2',
].join('\n'));
await fs.chmod(unsafeCurrentPath, 0o622);
const unsafeCurrentBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: unsafeCurrentSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: unsafeCurrentPath, content: 'UNSAFE_CURRENT_PRELOAD', missing: false }],
  },
};
await handler(unsafeCurrentBootstrapEvent);
if (unsafeCurrentBootstrapEvent.context.bootstrapFiles.some((file) => file.path === unsafeCurrentPath)) {
  throw new Error('unsafe-mode current handoff remained injectable or preloaded');
}
if (!unsafeCurrentBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('unsafe-mode current handoff suppressed independent project recovery');
}

const unsafeStateSessionKey = 'agent:main:unsafe-state-mode';
const unsafeStateCurrent = path.join(root, `memory/session_handoffs/session_${unsafeStateSessionKey}.MEMORY.md`);
const unsafeStatePath = path.join(root, `memory/session_handoffs/session_${unsafeStateSessionKey}.state.json`);
registry.sessions[unsafeStateSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(unsafeStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000c3',
].join('\n'));
await fs.writeFile(unsafeStatePath, '{}\n');
await fs.chmod(unsafeStatePath, 0o622);
const unsafeStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: unsafeStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: unsafeStateCurrent, content: 'UNSAFE_STATE_PRELOAD', missing: false }],
  },
};
await handler(unsafeStateBootstrapEvent);
if (unsafeStateBootstrapEvent.context.bootstrapFiles.some((file) => file.path === unsafeStateCurrent)) {
  throw new Error('unsafe-mode lifecycle state allowed or retained a session handoff');
}
if (!unsafeStateBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('unsafe-mode lifecycle state suppressed independent project recovery');
}
if (((await fs.stat(unsafeStatePath)).mode & 0o022) === 0) {
  throw new Error('unsafe-mode lifecycle state was unexpectedly replaced or normalized');
}

const mkdirFailureSessionKey = 'agent:main:lifecycle-mkdir-failure';
const mkdirFailureCurrent = path.join(
  root,
  `memory/session_handoffs/session_${mkdirFailureSessionKey}.MEMORY.md`,
);
registry.sessions[mkdirFailureSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(mkdirFailureCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000d1',
].join('\n'));
const originalMkdirForLifecycleFailure = fs.mkdir;
const handoffDirectory = path.dirname(mkdirFailureCurrent);
fs.mkdir = async (target, ...args) => {
  if (String(target) === handoffDirectory) {
    throw Object.assign(new Error('injected lifecycle directory EACCES'), { code: 'EACCES' });
  }
  return originalMkdirForLifecycleFailure.call(fs, target, ...args);
};
const mkdirFailureBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: mkdirFailureSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: mkdirFailureCurrent,
      content: 'PRELOADED_MKDIR_FAILURE_SENTINEL',
      missing: false,
    }],
  },
};
try {
  await handler(mkdirFailureBootstrapEvent);
} finally {
  fs.mkdir = originalMkdirForLifecycleFailure;
}
if (mkdirFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.path === mkdirFailureCurrent)) {
  throw new Error('lifecycle mkdir failure left a preloaded untracked session handoff');
}
if (!mkdirFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('lifecycle mkdir failure suppressed independent project recovery');
}

await handler(baseEvent);
const concurrentGenerationContent = await fs.readFile(current, 'utf8');
const concurrentGenerationId = concurrentGenerationContent.match(/^- generationId: (\S+)$/m)?.[1];
const concurrentBootstrapEvents = Array.from({ length: 16 }, () => ({
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
}));
await Promise.all(concurrentBootstrapEvents.map((event) => handler(event)));
const concurrentSessionInjections = concurrentBootstrapEvents.reduce(
  (count, event) => count + Number(event.context.bootstrapFiles.some((file) => file.path === current)),
  0,
);
if (concurrentSessionInjections !== 1) {
  throw new Error(`concurrent bootstraps injected one generation ${concurrentSessionInjections} times instead of once`);
}
const concurrentLifecycleState = JSON.parse(await fs.readFile(lifecycleStatePath, 'utf8'));
if (concurrentLifecycleState.injection?.generationId !== concurrentGenerationId
    || concurrentLifecycleState.injection?.attempts !== 1) {
  throw new Error('concurrent bootstrap lifecycle state does not identify the injected generation');
}

await handler(baseEvent);
let releaseBootstrapSnapshot;
let markBootstrapSnapshotStarted;
const bootstrapSnapshotStarted = new Promise((resolve) => { markBootstrapSnapshotStarted = resolve; });
const bootstrapSnapshotRelease = new Promise((resolve) => { releaseBootstrapSnapshot = resolve; });
const originalOpenForSessionQueueRace = fs.open;
let heldCurrentRead = false;
fs.open = async (target, ...args) => {
  const handle = await originalOpenForSessionQueueRace.call(fs, target, ...args);
  if (String(target) === current && !heldCurrentRead) {
    heldCurrentRead = true;
    const originalHandleRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      markBootstrapSnapshotStarted();
      await bootstrapSnapshotRelease;
      return originalHandleRead(...readArgs);
    };
  }
  return handle;
};
const serializedBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
const heldBootstrapPromise = handler(serializedBootstrapEvent);
await bootstrapSnapshotStarted;
const overlappingCompactPromise = handler({ ...baseEvent, timestamp: new Date().toISOString() });
const compactOutcomeBeforeRelease = await Promise.race([
  overlappingCompactPromise.then(() => 'completed'),
  new Promise((resolve) => setTimeout(() => resolve('waiting'), 200)),
]);
releaseBootstrapSnapshot();
await Promise.all([heldBootstrapPromise, overlappingCompactPromise]);
fs.open = originalOpenForSessionQueueRace;
if (compactOutcomeBeforeRelease !== 'waiting') {
  throw new Error('same-session compact write bypassed the bootstrap lifecycle queue');
}

await handler(baseEvent);
const nextGenerationContent = await fs.readFile(current, 'utf8');
const nextGenerationId = nextGenerationContent.match(/^- generationId: (\S+)$/m)?.[1];
if (!nextGenerationId || nextGenerationId === concurrentGenerationId) {
  throw new Error('new handoff did not advance generation before lifecycle reset test');
}
const nextGenerationBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(nextGenerationBootstrapEvent);
if (!nextGenerationBootstrapEvent.context.bootstrapFiles.some((file) => file.path === current)) {
  throw new Error('a new handoff generation did not become eligible for one bounded injection');
}

const injectionBeforeEarlyRefresh = JSON.parse(await fs.readFile(lifecycleStatePath, 'utf8')).injection;
await handler({
  type: 'message',
  action: 'preprocessed',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: { sessionId: 'test-session', sessionFile, totalTokens: 7000, contextTokens: 10000 },
  },
});
const stateAfterEarlyRefresh = JSON.parse(await fs.readFile(lifecycleStatePath, 'utf8'));
if (JSON.stringify(stateAfterEarlyRefresh.injection) !== JSON.stringify(injectionBeforeEarlyRefresh)) {
  throw new Error('early-handoff state refresh erased or mutated injection lifecycle state');
}
const afterEarlyGeneration = (await fs.readFile(current, 'utf8')).match(/^- generationId: (\S+)$/m)?.[1];
if (!afterEarlyGeneration || afterEarlyGeneration === injectionBeforeEarlyRefresh.generationId) {
  throw new Error('early-handoff refresh did not create a new generation');
}
const afterEarlyBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: 'agent:main:test',
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(afterEarlyBootstrapEvent);
if (!afterEarlyBootstrapEvent.context.bootstrapFiles.some((file) => file.path === current)) {
  throw new Error('generation created by early refresh was not eligible for one injection');
}

const expiredSessionKey = 'agent:main:expired-injection';
const expiredCurrent = path.join(root, `memory/session_handoffs/session_${expiredSessionKey}.MEMORY.md`);
const expiredStatePath = path.join(root, `memory/session_handoffs/session_${expiredSessionKey}.state.json`);
await fs.writeFile(expiredCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-000000000024',
].join('\n'));
const expiredMtime = new Date(Date.now() - (25 * 60 * 60 * 1000));
await fs.utimes(expiredCurrent, expiredMtime, expiredMtime);
const expiredBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: expiredSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: expiredCurrent, content: 'STALE_PRELOADED', missing: false }],
  },
};
await handler(expiredBootstrapEvent);
if (expiredBootstrapEvent.context.bootstrapFiles.some((file) => file.path === expiredCurrent)) {
  throw new Error('expired handoff generation remained in bootstrap files');
}
const expiredState = JSON.parse(await fs.readFile(expiredStatePath, 'utf8'));
if (expiredState.injection?.status !== 'expired'
    || expiredState.injection?.attempts !== 0
    || expiredState.injection?.expiresAtMs > Date.now()) {
  throw new Error('expired generation lifecycle state is missing or inaccurate');
}

const stateWriteFailureSessionKey = 'agent:main:state-write-failure';
const stateWriteFailureCurrent = path.join(
  root,
  `memory/session_handoffs/session_${stateWriteFailureSessionKey}.MEMORY.md`,
);
const stateWriteFailureState = path.join(
  root,
  `memory/session_handoffs/session_${stateWriteFailureSessionKey}.state.json`,
);
registry.sessions[stateWriteFailureSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(stateWriteFailureCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e2',
].join('\n'));
const originalRenameForStateWriteFailure = fs.rename;
const injectedStateWriteFailure = Object.assign(new Error('injected lifecycle state rename EIO'), { code: 'EIO' });
fs.rename = async (from, to) => {
  if (String(to) === stateWriteFailureState) throw injectedStateWriteFailure;
  return originalRenameForStateWriteFailure.call(fs, from, to);
};
const stateWriteFailureBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: stateWriteFailureSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: stateWriteFailureCurrent,
      content: 'PRELOADED_STATE_WRITE_FAILURE_SENTINEL',
      missing: false,
    }],
  },
};
try {
  await handler(stateWriteFailureBootstrapEvent);
} finally {
  fs.rename = originalRenameForStateWriteFailure;
}
if (stateWriteFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.path === stateWriteFailureCurrent)) {
  throw new Error('lifecycle state write failure left a preloaded untracked session handoff');
}
if (!stateWriteFailureBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('lifecycle state write failure suppressed independent project recovery');
}
const stateWriteRetryEvent = {
  ...stateWriteFailureBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(stateWriteRetryEvent);
if (!stateWriteRetryEvent.context.bootstrapFiles.some((file) => file.path === stateWriteFailureCurrent)) {
  throw new Error('generation was not injectable after transient lifecycle state write failure cleared');
}

const malformedStateSessionKey = 'agent:main:malformed-state';
const malformedStateCurrent = path.join(root, `memory/session_handoffs/session_${malformedStateSessionKey}.MEMORY.md`);
const malformedStatePath = path.join(root, `memory/session_handoffs/session_${malformedStateSessionKey}.state.json`);
registry.sessions[malformedStateSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(malformedStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e3',
].join('\n'));
await fs.writeFile(malformedStatePath, '{not valid json');
const malformedStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: malformedStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: malformedStateCurrent,
      content: 'PRELOADED_MALFORMED_STATE_SENTINEL',
      missing: false,
    }],
  },
};
await handler(malformedStateBootstrapEvent);
const malformedStateEntries = await fs.readdir(path.dirname(malformedStatePath));
if (!malformedStateEntries.some((name) => name.startsWith(`${path.basename(malformedStatePath)}.corrupt-`))) {
  throw new Error('malformed lifecycle state was not preserved before recovery');
}
if (malformedStateBootstrapEvent.context.bootstrapFiles.some((file) => file.path === malformedStateCurrent)) {
  throw new Error('malformed lifecycle state injected in the same attempt that quarantined state');
}
if (!malformedStateBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('malformed lifecycle state suppressed independent project recovery');
}
const malformedStateRetryEvent = {
  ...malformedStateBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(malformedStateRetryEvent);
if (!malformedStateRetryEvent.context.bootstrapFiles.some((file) => file.path === malformedStateCurrent)) {
  throw new Error('quarantined malformed lifecycle state did not recover on the next attempt');
}

const invalidShapeSessionKey = 'agent:main:invalid-state-shape';
const invalidShapeCurrent = path.join(root, `memory/session_handoffs/session_${invalidShapeSessionKey}.MEMORY.md`);
const invalidShapePath = path.join(root, `memory/session_handoffs/session_${invalidShapeSessionKey}.state.json`);
registry.sessions[invalidShapeSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(invalidShapeCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e8',
].join('\n'));
await fs.writeFile(invalidShapePath, '[]\n');
const invalidShapeBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: invalidShapeSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: invalidShapeCurrent, content: 'INVALID_SHAPE_PRELOAD', missing: false }],
  },
};
await handler(invalidShapeBootstrapEvent);
if (invalidShapeBootstrapEvent.context.bootstrapFiles.some((file) => file.path === invalidShapeCurrent)) {
  throw new Error('invalid lifecycle state shape injected in the same attempt that quarantined state');
}
if (!invalidShapeBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('invalid lifecycle state shape suppressed independent project recovery');
}
const invalidShapeRetryEvent = {
  ...invalidShapeBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(invalidShapeRetryEvent);
if (!invalidShapeRetryEvent.context.bootstrapFiles.some((file) => file.path === invalidShapeCurrent)) {
  throw new Error('quarantined invalid lifecycle state shape did not recover on the next attempt');
}

const invalidInjectionSessionKey = 'agent:main:invalid-injection-shape';
const invalidInjectionCurrent = path.join(root, `memory/session_handoffs/session_${invalidInjectionSessionKey}.MEMORY.md`);
const invalidInjectionStatePath = path.join(root, `memory/session_handoffs/session_${invalidInjectionSessionKey}.state.json`);
registry.sessions[invalidInjectionSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
const invalidInjectionGeneration = '00000000-0000-4000-8000-0000000000e9';
await fs.writeFile(invalidInjectionCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  `- generationId: ${invalidInjectionGeneration}`,
].join('\n'));
await fs.writeFile(invalidInjectionStatePath, `${JSON.stringify({
  injection: {
    generationId: invalidInjectionGeneration,
    attempts: 2,
    consumed: false,
    status: 'injected-once-unconfirmed',
    mode: 'single-bootstrap-no-delivery-correlation',
    expiresAtMs: Date.now() + 60_000,
  },
}, null, 2)}\n`);
const invalidInjectionEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: invalidInjectionSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{ name: 'MEMORY.md', path: invalidInjectionCurrent, content: 'INVALID_INJECTION_PRELOAD', missing: false }],
  },
};
await handler(invalidInjectionEvent);
if (invalidInjectionEvent.context.bootstrapFiles.some((file) => file.path === invalidInjectionCurrent)) {
  throw new Error('parseable invalid injection state was silently treated as pristine lifecycle state');
}
const invalidInjectionStateEntries = await fs.readdir(path.dirname(invalidInjectionStatePath));
if (!invalidInjectionStateEntries.some((name) => name.startsWith(`${path.basename(invalidInjectionStatePath)}.corrupt-`))) {
  throw new Error('parseable invalid injection state was not quarantined');
}
const invalidInjectionRetryEvent = {
  ...invalidInjectionEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(invalidInjectionRetryEvent);
if (!invalidInjectionRetryEvent.context.bootstrapFiles.some((file) => file.path === invalidInjectionCurrent)) {
  throw new Error('quarantined parseable invalid injection state did not recover on the next clean attempt');
}

const inconsistentInjectionSessionKey = 'agent:main:inconsistent-injection-state';
const inconsistentInjectionCurrent = path.join(
  root,
  `memory/session_handoffs/session_${inconsistentInjectionSessionKey}.MEMORY.md`,
);
const inconsistentInjectionStatePath = path.join(
  root,
  `memory/session_handoffs/session_${inconsistentInjectionSessionKey}.state.json`,
);
const inconsistentInjectionGeneration = '00000000-0000-4000-8000-0000000000ea';
await fs.writeFile(inconsistentInjectionCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  `- generationId: ${inconsistentInjectionGeneration}`,
].join('\n'));
await fs.writeFile(inconsistentInjectionStatePath, `${JSON.stringify({
  injection: {
    generationId: inconsistentInjectionGeneration,
    attempts: 0,
    consumed: false,
    status: 'injected-once-unconfirmed',
    mode: 'single-bootstrap-no-delivery-correlation',
    expiresAtMs: Date.now() + 60_000,
  },
}, null, 2)}\n`);
const inconsistentInjectionEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: inconsistentInjectionSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: inconsistentInjectionCurrent,
      content: 'INCONSISTENT_INJECTION_PRELOAD',
      missing: false,
    }],
  },
};
await handler(inconsistentInjectionEvent);
const inconsistentInjectionEntries = await fs.readdir(path.dirname(inconsistentInjectionStatePath));
if (inconsistentInjectionEvent.context.bootstrapFiles.some((file) => file.path === inconsistentInjectionCurrent)
    || !inconsistentInjectionEntries.some(
      (name) => name.startsWith(`${path.basename(inconsistentInjectionStatePath)}.corrupt-`),
    )) {
  throw new Error('inconsistent injected lifecycle status/attempt count did not fail closed into quarantine');
}
const inconsistentInjectionRetryEvent = {
  ...inconsistentInjectionEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(inconsistentInjectionRetryEvent);
if (!inconsistentInjectionRetryEvent.context.bootstrapFiles.some(
  (file) => file.path === inconsistentInjectionCurrent,
)) {
  throw new Error('quarantined inconsistent injection state did not recover on the next clean attempt');
}

const unknownStateSessionKey = 'agent:main:unknown-state-fields';
const unknownStateCurrent = path.join(root, `memory/session_handoffs/session_${unknownStateSessionKey}.MEMORY.md`);
const unknownStatePath = path.join(root, `memory/session_handoffs/session_${unknownStateSessionKey}.state.json`);
const unknownStateSecret = 'P1C_UNKNOWN_STATE_SECRET_MUST_NOT_PERSIST';
await fs.writeFile(unknownStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e4',
].join('\n'));
await fs.writeFile(unknownStatePath, JSON.stringify({
  lastEarlyAtMs: 0,
  unknownSecretField: unknownStateSecret,
  nestedUnknown: { payload: unknownStateSecret },
}, null, 2));
const unknownStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: unknownStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(unknownStateBootstrapEvent);
const rewrittenUnknownState = await fs.readFile(unknownStatePath, 'utf8');
if (rewrittenUnknownState.includes(unknownStateSecret)
    || rewrittenUnknownState.includes('unknownSecretField')
    || rewrittenUnknownState.includes('nestedUnknown')) {
  throw new Error('lifecycle state copied unknown secret-bearing fields into persisted state');
}

const knownFieldStateSessionKey = 'agent:main:known-state-field-secret';
const knownFieldStatePath = path.join(root, `memory/session_handoffs/session_${knownFieldStateSessionKey}.state.json`);
const knownFieldStateTranscript = path.join(root, 'known-state-field-secret.jsonl');
const knownFieldStateSecret = 'P1C_KNOWN_GENERATION_SECRET_MUST_NOT_PERSIST';
await fs.writeFile(knownFieldStateTranscript, `${JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'Exercise strict lifecycle generation schema.' },
})}\n`);
await fs.writeFile(knownFieldStatePath, `${JSON.stringify({
  injection: {
    generationId: knownFieldStateSecret,
    attempts: 1,
    consumed: false,
    status: 'injected-once-unconfirmed',
    mode: 'single-bootstrap-no-delivery-correlation',
    injectedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  },
}, null, 2)}\n`);
await handler({
  type: 'message',
  action: 'preprocessed',
  sessionKey: knownFieldStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: {
      sessionId: 'known-state-field-secret-session',
      sessionFile: knownFieldStateTranscript,
      totalTokens: 7000,
      contextTokens: 10000,
    },
  },
});
const knownFieldStateEntries = await fs.readdir(path.dirname(knownFieldStatePath));
const knownFieldCorruptPaths = knownFieldStateEntries
  .filter((name) => name.startsWith(`${path.basename(knownFieldStatePath)}.corrupt-`))
  .map((name) => path.join(path.dirname(knownFieldStatePath), name));
if (knownFieldCorruptPaths.length < 1) {
  throw new Error('invalid known lifecycle field did not fail closed into quarantine metadata');
}
const knownFieldPersistedTexts = await Promise.all([
  fs.readFile(knownFieldStatePath, 'utf8').catch((error) => (error?.code === 'ENOENT' ? '' : Promise.reject(error))),
  ...knownFieldCorruptPaths.map((filePath) => fs.readFile(filePath, 'utf8')),
]);
if (knownFieldPersistedTexts.some((text) => text.includes(knownFieldStateSecret))) {
  throw new Error('lifecycle state persisted a secret through the known generationId field');
}

const corruptDirectorySessionKey = 'agent:main:corrupt-retention-directory';
const corruptDirectoryStatePath = path.join(root, `memory/session_handoffs/session_${corruptDirectorySessionKey}.state.json`);
const corruptDirectoryArtifact = `${corruptDirectoryStatePath}.corrupt-directory-blocker`;
const corruptDirectoryTranscript = path.join(root, 'corrupt-retention-directory.jsonl');
await fs.mkdir(corruptDirectoryArtifact);
await fs.writeFile(corruptDirectoryTranscript, `${JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'Exercise corrupt-artifact directory retention.' },
})}\n`);
await handler({
  type: 'message',
  action: 'preprocessed',
  sessionKey: corruptDirectorySessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: {
      sessionId: 'corrupt-retention-directory-session',
      sessionFile: corruptDirectoryTranscript,
      totalTokens: 7000,
      contextTokens: 10000,
    },
  },
});
await fs.access(corruptDirectoryStatePath).catch(() => {
  throw new Error('corrupt-artifact directory blocked all subsequent lifecycle state writes');
});
const corruptDirectoryStat = await fs.lstat(corruptDirectoryArtifact);
if (!corruptDirectoryStat.isDirectory()) {
  throw new Error('corrupt-artifact retention followed or replaced a directory entry');
}

const boundedStateSessionKey = 'agent:main:bounded-state-read';
const boundedStateCurrent = path.join(root, `memory/session_handoffs/session_${boundedStateSessionKey}.MEMORY.md`);
const boundedStatePath = path.join(root, `memory/session_handoffs/session_${boundedStateSessionKey}.state.json`);
await fs.writeFile(boundedStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e5',
].join('\n'));
await fs.writeFile(boundedStatePath, '{}\n');
const originalReadFileForBoundedState = fs.readFile;
const originalOpenForBoundedState = fs.open;
let forbiddenUnboundedStateReads = 0;
let boundedStateOpenCount = 0;
let boundedStateRequestedBytes = 0;
fs.readFile = async (target, ...args) => {
  if (String(target) === boundedStatePath) {
    forbiddenUnboundedStateReads += 1;
    throw Object.assign(new Error('unbounded lifecycle state read forbidden'), { code: 'EFBIG' });
  }
  return originalReadFileForBoundedState.call(fs, target, ...args);
};
fs.open = async (target, ...args) => {
  const handle = await originalOpenForBoundedState.call(fs, target, ...args);
  if (String(target) === boundedStatePath) {
    boundedStateOpenCount += 1;
    const originalHandleRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      boundedStateRequestedBytes += length;
      return originalHandleRead(buffer, offset, length, position);
    };
  }
  return handle;
};
const boundedStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: boundedStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
try {
  await handler(boundedStateBootstrapEvent);
} finally {
  fs.readFile = originalReadFileForBoundedState;
  fs.open = originalOpenForBoundedState;
}
if (forbiddenUnboundedStateReads !== 0
    || boundedStateOpenCount !== 1
    || boundedStateRequestedBytes > 32769) {
  throw new Error(`lifecycle state did not use one bounded handle read: ${JSON.stringify({
    forbiddenUnboundedStateReads,
    boundedStateOpenCount,
    boundedStateRequestedBytes,
  })}`);
}

const oversizedStateSessionKey = 'agent:main:oversized-state';
const oversizedStateCurrent = path.join(root, `memory/session_handoffs/session_${oversizedStateSessionKey}.MEMORY.md`);
const oversizedStatePath = path.join(root, `memory/session_handoffs/session_${oversizedStateSessionKey}.state.json`);
registry.sessions[oversizedStateSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
await fs.writeFile(oversizedStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e6',
].join('\n'));
await fs.writeFile(oversizedStatePath, JSON.stringify({ padding: 'X'.repeat(64 * 1024) }));
const oversizedStateBase = path.basename(oversizedStatePath);
for (let i = 0; i < 5; i += 1) {
  const corruptPath = corruptStateArtifactPath(oversizedStatePath, i, 100);
  await fs.writeFile(corruptPath, `seed-${i}`);
  if (i < 2) {
    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    await fs.utimes(corruptPath, old, old);
  }
}
const oversizedStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: oversizedStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: oversizedStateCurrent,
      content: 'PRELOADED_OVERSIZED_STATE_SENTINEL',
      missing: false,
    }],
  },
};
await handler(oversizedStateBootstrapEvent);
if (oversizedStateBootstrapEvent.context.bootstrapFiles.some((file) => file.path === oversizedStateCurrent)) {
  throw new Error('oversized lifecycle state injected in the same attempt that quarantined state');
}
if (!oversizedStateBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('oversized lifecycle state suppressed independent project recovery');
}
const oversizedStateRetryEvent = {
  ...oversizedStateBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(oversizedStateRetryEvent);
if (!oversizedStateRetryEvent.context.bootstrapFiles.some((file) => file.path === oversizedStateCurrent)) {
  throw new Error('quarantined oversized lifecycle state did not recover on the next attempt');
}
const recoveredOversizedStateStat = await fs.stat(oversizedStatePath);
if (recoveredOversizedStateStat.size > 32 * 1024) {
  throw new Error(`oversized lifecycle state was not replaced with bounded state: ${recoveredOversizedStateStat.size}`);
}
const stateDirEntriesAfterPrune = await fs.readdir(path.dirname(oversizedStatePath));
const retainedStateCorruptNames = stateDirEntriesAfterPrune.filter((name) => name.startsWith(`${oversizedStateBase}.corrupt-`));
if (retainedStateCorruptNames.length > 3) {
  throw new Error(`lifecycle corrupt-state retention exceeded 3: ${retainedStateCorruptNames.length}`);
}
for (const name of retainedStateCorruptNames) {
  const stat = await fs.stat(path.join(path.dirname(oversizedStatePath), name));
  if (stat.size > 32 * 1024 || stat.mtimeMs < Date.now() - (7 * 24 * 60 * 60 * 1000)) {
    throw new Error(`lifecycle corrupt-state artifact exceeded size/age bound: ${name}`);
  }
}

const routineRetentionSessionKey = 'agent:main:routine-state-retention';
const routineRetentionCurrent = path.join(root, `memory/session_handoffs/session_${routineRetentionSessionKey}.MEMORY.md`);
const routineRetentionState = path.join(root, `memory/session_handoffs/session_${routineRetentionSessionKey}.state.json`);
await fs.writeFile(routineRetentionCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000f1',
].join('\n'));
await fs.writeFile(routineRetentionState, '{}\n');
for (let index = 0; index < 6; index += 1) {
  const corruptPath = corruptStateArtifactPath(routineRetentionState, index, 200);
  await fs.writeFile(corruptPath, index === 1 ? 'X'.repeat((32 * 1024) + 1) : `routine-${index}`);
  if (index === 0) {
    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
    await fs.utimes(corruptPath, old, old);
  }
}
const routineRetentionBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: routineRetentionSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(routineRetentionBootstrapEvent);
if (!routineRetentionBootstrapEvent.context.bootstrapFiles.some((file) => file.path === routineRetentionCurrent)) {
  throw new Error('routine state commit fixture did not reach a successful lifecycle write');
}
const routineRetentionNames = (await fs.readdir(path.dirname(routineRetentionState)))
  .filter((name) => name.startsWith(`${path.basename(routineRetentionState)}.corrupt-`));
if (routineRetentionNames.length > 3) {
  throw new Error(`routine successful state commit did not enforce corrupt retention count: ${routineRetentionNames.length}`);
}
for (const name of routineRetentionNames) {
  const stat = await fs.stat(path.join(path.dirname(routineRetentionState), name));
  if (stat.size > 32 * 1024 || stat.mtimeMs < Date.now() - (7 * 24 * 60 * 60 * 1000)) {
    throw new Error(`routine successful state commit retained an oversized or expired corrupt artifact: ${name}`);
  }
}

const corruptNeighborBaseKey = 'agent:main:corrupt-neighbor-base';
const corruptNeighborSuffix = '1700000000999-9999-00000000-0000-4000-8000-000000000999';
const corruptNeighborKey = `${corruptNeighborBaseKey}.state.json.corrupt-${corruptNeighborSuffix}`;
const corruptNeighborState = path.join(
  root,
  `memory/session_handoffs/session_${corruptNeighborKey}.state.json`,
);
const corruptNeighborBytes = `${JSON.stringify({ neighborPrimaryState: true })}\n`;
await fs.writeFile(corruptNeighborState, corruptNeighborBytes, { mode: 0o600 });
const corruptNeighborOldTime = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
await fs.utimes(corruptNeighborState, corruptNeighborOldTime, corruptNeighborOldTime);
const corruptNeighborTranscript = path.join(root, 'corrupt-neighbor-base.jsonl');
await fs.writeFile(corruptNeighborTranscript, `${JSON.stringify({
  type: 'message',
  message: { role: 'user', content: 'Exercise exact corrupt-state retention ownership.' },
})}\n`);
await handler({
  type: 'message',
  action: 'preprocessed',
  sessionKey: corruptNeighborBaseKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    sessionEntry: {
      sessionId: 'corrupt-neighbor-base-session',
      sessionFile: corruptNeighborTranscript,
      totalTokens: 7000,
      contextTokens: 10000,
    },
  },
});
const corruptNeighborAfter = await fs.readFile(corruptNeighborState, 'utf8').catch(
  (error) => (error?.code === 'ENOENT' ? undefined : Promise.reject(error)),
);
if (corruptNeighborAfter !== corruptNeighborBytes) {
  throw new Error('corrupt-state retention deleted a prefix-neighbor primary lifecycle state');
}

const symlinkCurrentSessionKey = 'agent:main:symlink-current';
const symlinkCurrentPath = path.join(root, `memory/session_handoffs/session_${symlinkCurrentSessionKey}.MEMORY.md`);
const symlinkCurrentSecretPath = path.join(root, 'arbitrary-local-secret.txt');
const symlinkCurrentSecret = 'P1C_CURRENT_SYMLINK_SECRET_MUST_NOT_INJECT';
await fs.writeFile(symlinkCurrentSecretPath, symlinkCurrentSecret);
await fs.symlink(symlinkCurrentSecretPath, symlinkCurrentPath);
registry.sessions[symlinkCurrentSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
const symlinkCurrentBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: symlinkCurrentSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: symlinkCurrentPath,
      content: 'PRELOADED_SYMLINK_CURRENT',
      missing: false,
    }],
  },
};
await handler(symlinkCurrentBootstrapEvent);
const serializedSymlinkCurrentBootstrap = JSON.stringify(symlinkCurrentBootstrapEvent.context.bootstrapFiles);
if (serializedSymlinkCurrentBootstrap.includes(symlinkCurrentSecret)
    || symlinkCurrentBootstrapEvent.context.bootstrapFiles.some((file) => file.path === symlinkCurrentPath)) {
  throw new Error('bootstrap followed a symlinked current handoff and exposed local file content');
}
if (!symlinkCurrentBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('symlinked current handoff failure suppressed independent project recovery');
}

const symlinkStateSessionKey = 'agent:main:symlink-state';
const symlinkStateCurrent = path.join(root, `memory/session_handoffs/session_${symlinkStateSessionKey}.MEMORY.md`);
const symlinkStatePath = path.join(root, `memory/session_handoffs/session_${symlinkStateSessionKey}.state.json`);
const symlinkStateSecretPath = path.join(root, 'arbitrary-state-secret.json');
const symlinkStateSecret = 'P1C_STATE_SYMLINK_SECRET_MUST_NOT_READ';
await fs.writeFile(symlinkStateCurrent, [
  '# Current Session Handoff — Compact Safe',
  '## Session Metadata',
  '- schemaVersion: 2',
  '- generationId: 00000000-0000-4000-8000-0000000000e7',
].join('\n'));
await fs.writeFile(symlinkStateSecretPath, JSON.stringify({ unknownSecret: symlinkStateSecret }));
await fs.symlink(symlinkStateSecretPath, symlinkStatePath);
registry.sessions[symlinkStateSessionKey] = { project: 'demo-project' };
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
const symlinkStateBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: symlinkStateSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: {
    workspaceDir: root,
    bootstrapFiles: [{
      name: 'MEMORY.md',
      path: symlinkStateCurrent,
      content: 'PRELOADED_SYMLINK_STATE',
      missing: false,
    }],
  },
};
await handler(symlinkStateBootstrapEvent);
const serializedSymlinkStateBootstrap = JSON.stringify(symlinkStateBootstrapEvent.context.bootstrapFiles);
if (serializedSymlinkStateBootstrap.includes(symlinkStateSecret)
    || symlinkStateBootstrapEvent.context.bootstrapFiles.some((file) => file.path === symlinkStateCurrent)) {
  throw new Error('bootstrap followed a symlinked lifecycle state or retained an untracked handoff');
}
if (!symlinkStateBootstrapEvent.context.bootstrapFiles.some((file) => file.name === 'PROJECT_RECOVERY.md')) {
  throw new Error('symlinked lifecycle state failure suppressed independent project recovery');
}
if (!(await fs.readFile(symlinkStateSecretPath, 'utf8')).includes(symlinkStateSecret)) {
  throw new Error('symlinked lifecycle state handling modified its external target');
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

const legacyContentHashSessionKey = 'agent:main:legacy-content-hash';
const legacyContentHashPath = path.join(
  root,
  `memory/session_handoffs/session_${legacyContentHashSessionKey}.MEMORY.md`,
);
await fs.writeFile(legacyContentHashPath, '# Legacy v1 Handoff\nLEGACY_CONTENT_HASH_ONE_SHOT\n');
const legacyContentHashBootstrapEvent = {
  type: 'agent',
  action: 'bootstrap',
  sessionKey: legacyContentHashSessionKey,
  timestamp: new Date().toISOString(),
  messages: [],
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(legacyContentHashBootstrapEvent);
if (!legacyContentHashBootstrapEvent.context.bootstrapFiles.some((file) => file.path === legacyContentHashPath)) {
  throw new Error('bounded legacy handoff did not receive its first content-hash generation attempt');
}
const repeatedLegacyContentHashBootstrapEvent = {
  ...legacyContentHashBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(repeatedLegacyContentHashBootstrapEvent);
if (repeatedLegacyContentHashBootstrapEvent.context.bootstrapFiles.some((file) => file.path === legacyContentHashPath)) {
  throw new Error('bounded legacy content-hash generation was injected more than once');
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
if (legacyOversizedBootstrapEvent.context.bootstrapFiles.some((file) => file.path === legacyOversizedPath)) {
  throw new Error('oversized legacy handoff bypassed bounded bootstrap fail-closed policy');
}
const repeatedLegacyBootstrapEvent = {
  ...legacyOversizedBootstrapEvent,
  context: { workspaceDir: root, bootstrapFiles: [] },
};
await handler(repeatedLegacyBootstrapEvent);
if (repeatedLegacyBootstrapEvent.context.bootstrapFiles.some((file) => file.path === legacyOversizedPath)) {
  throw new Error('oversized legacy handoff became injectable on retry');
}

const indexPath = path.join(root, 'memory/session_handoffs/index.json');
const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
if (!index.sessions['agent:main:high'] || !index.sessions['agent:main:test']) {
  throw new Error('handoff index missing expected sessions');
}

const result = {
  ok: true,
  root,
  injected: bootstrapEvent.context.bootstrapFiles.length,
  otherInjected: otherBootstrapEvent.context.bootstrapFiles.length,
  unregisteredInjected: unregisteredBootstrapEvent.context.bootstrapFiles.length,
  earlyPhase: index.sessions['agent:main:high'].phase,
  oneShotGeneration: 'pass',
  concurrentGenerationInjections: concurrentSessionInjections,
  newGenerationReenabled: 'pass',
  expiredGeneration: expiredState.injection.status,
  stateReadFailure: 'fail-closed',
  stateReadPermissionDenied: 'fail-closed',
  stateReadFailureProjectRecovery: 'pass',
  currentReadFailure: 'fail-closed',
  unsafeCurrentMode: 'fail-closed',
  unsafeStateMode: 'fail-closed',
  lifecycleMkdirFailure: 'fail-closed',
  stateWriteFailureRetry: 'pass',
  stateWriteFailureProjectRecovery: 'pass',
  preloadedFailureHandoffRemoval: 'pass',
  malformedStateFirstAttempt: 'fail-closed',
  invalidStateShapeFirstAttempt: 'fail-closed',
  inconsistentInjectionState: 'fail-closed-next-attempt-pass',
  oversizedStateFirstAttempt: 'fail-closed',
  malformedStateRecovery: 'next-attempt-pass',
  routineCorruptStateRetention: 'pass',
  corruptStateNeighborIsolation: 'pass',
  legacyContentHashGeneration: 'pass',
  cleaned: true,
};
await fs.rm(root, { recursive: true, force: true });
try {
  await fs.access(root);
  throw new Error('successful core suite left its temporary tree behind');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
console.log(JSON.stringify(result));
