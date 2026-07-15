import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const HOOK_NAME = "compact-handoff";
const MAX_RECENT_MESSAGES = 24;
const MAX_SINGLE_EVIDENCE_CHARS = 1200;
const MAX_HANDOFF_BODY_CHARS = 8000;
const MAX_PROJECT_POINTER_CHARS = 2000;
const MAX_TOTAL_BOOTSTRAP_CHARS = 10000;
const MAX_EXACT_REFERENCES = 20;
const EARLY_TOKEN_RATIO = 0.65;
const EARLY_FORCE_TOKEN_RATIO = 0.75;
const EARLY_MIN_TOKEN_DELTA = 10000;
const EARLY_MIN_INTERVAL_MS = 20 * 60 * 1000;
const EARLY_TRANSCRIPT_BYTES = 1500 * 1000;

type MessageProvenance = "real_user" | "assistant" | "synthetic_system" | "tool_or_runtime" | "unknown";

type TranscriptMessage = {
  provenance: MessageProvenance;
  text: string;
  order: number;
};

function logWarn(message: string, error?: unknown) {
  const suffix = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : "";
  console.warn(`[${HOOK_NAME}] ${message}${suffix}`);
}

function safeSlug(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180) || "unknown";
}

function parseAgentId(sessionKey: string | undefined): string {
  const match = typeof sessionKey === "string" ? sessionKey.match(/^agent:([^:]+):/) : undefined;
  return match?.[1] || "main";
}

function topicIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== "string") return undefined;
  const parts = sessionKey.split(":");
  return parts.length >= 5 ? parts[parts.length - 1] : undefined;
}

function safeProjectName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return /^[a-z][a-z0-9_-]{1,63}$/.test(trimmed) ? trimmed : undefined;
}

function localTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.TZ || "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return parts.replace(" ", "T");
}

function workspaceDirFromEvent(event: any): string {
  const contextDir = event?.context?.workspaceDir;
  if (typeof contextDir === "string" && contextDir.trim()) return contextDir;
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function sessionEntryFromEvent(event: any): any {
  return event?.context?.sessionEntry || event?.context?.previousSessionEntry || {};
}

async function readJsonFile(filePath: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function readProjectRegistration(workspaceDir: string, sessionKey: string | undefined): Promise<string | undefined> {
  if (!sessionKey) return undefined;
  const registry = await readJsonFile(path.join(workspaceDir, "memory", "project_states", "registry.json"));
  return safeProjectName(registry?.sessions?.[sessionKey]?.project);
}

function boolLabel(value: unknown): string {
  return value === true ? "true" : value === false ? "false" : "unknown";
}

function normalizeReferenceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clipUtf16Safe(redactSensitiveText(String(item)), 240, "…[reference truncated]"));
}

function allocateReferenceGroups(allowedValue: unknown, forbiddenValue: unknown): {
  allowed: string[];
  forbidden: string[];
  allowedOmitted: boolean;
  forbiddenOmitted: boolean;
} {
  const allowedSource = normalizeReferenceList(allowedValue);
  const forbiddenSource = normalizeReferenceList(forbiddenValue);
  const allowed: string[] = [];
  const forbidden: string[] = [];
  for (let index = 0; allowed.length + forbidden.length < MAX_EXACT_REFERENCES; index += 1) {
    let added = false;
    if (index < forbiddenSource.length) {
      forbidden.push(forbiddenSource[index]);
      added = true;
    }
    if (allowed.length + forbidden.length < MAX_EXACT_REFERENCES && index < allowedSource.length) {
      allowed.push(allowedSource[index]);
      added = true;
    }
    if (!added) break;
  }
  return {
    allowed,
    forbidden,
    allowedOmitted: allowed.length < allowedSource.length,
    forbiddenOmitted: forbidden.length < forbiddenSource.length,
  };
}

function listLabel(value: string[], omitted: boolean): string {
  if (!value.length) return omitted ? "…[references omitted by aggregate cap]" : "none";
  return [...value, ...(omitted ? ["…[additional references omitted]"] : [])].join(", ");
}

async function buildProjectRecoveryPointer(workspaceDir: string, sessionKey: string | undefined): Promise<{ project: string; content: string; virtualPath: string } | undefined> {
  const project = await readProjectRegistration(workspaceDir, sessionKey);
  if (!project) return undefined;
  const projectDir = path.join(workspaceDir, "memory", "project_states", project);
  const state = await readJsonFile(path.join(projectDir, "ACTIVE_TASK_STATE.json"));
  const gates = await readJsonFile(path.join(projectDir, "PROJECT_GATES.json"));
  if (!state || !gates) return undefined;
  const references = allocateReferenceGroups(state.allowed_actions, gates.forbidden_actions);
  const allowedLabel = clipUtf16Safe(
    listLabel(references.allowed, references.allowedOmitted),
    420,
    "…[allowed references truncated]",
  );
  const forbiddenLabel = clipUtf16Safe(
    listLabel(references.forbidden, references.forbiddenOmitted),
    420,
    "…[forbidden references truncated]",
  );

  const lines = [
    "## Project Recovery Pointer",
    `- project: ${compactMetadataValue(project, 160)}`,
    `- current_mode: ${compactMetadataValue(state.current_mode, 120)}`,
    `- active_task_id: ${compactMetadataValue(state.active_task_id ?? "none", 120)}`,
    `- task_title: ${compactMetadataValue(state.task_title ?? "none", 180)}`,
    `- risk_level: ${compactMetadataValue(state.risk_level, 80)}`,
    `- requires_jasper_approval: ${boolLabel(state.requires_jasper_approval)}`,
    `- requires_migration_first: ${boolLabel(state.requires_migration_first)}`,
    `- allowed_actions: ${allowedLabel}`,
    `- forbidden_actions: ${forbiddenLabel}`,
    `- current_step: ${compactMetadataValue(state.current_step, 140)}`,
    `- next_step: ${compactMetadataValue(state.next_step, 140)}`,
    `- resume_instruction: ${compactMetadataValue(state.resume_instruction ?? "Read project state files before acting.", 160)}`,
    "- first_read_files:",
    `  - memory/project_states/${project}/PROJECT_RULES.md`,
    `  - memory/project_states/${project}/PROJECT_GATES.json`,
    `  - memory/project_states/${project}/ACTIVE_TASK_STATE.json`,
    `  - memory/project_states/${project}/RECOVERY_CHECKLIST.md`,
    "- recovery_gate: run the project-state recovery/check script before acting when available.",
    "",
  ];

  let content = redactSensitiveText(lines.join("\n"));
  content = clipUtf16Safe(
    content,
    MAX_PROJECT_POINTER_CHARS,
    "\n\n…[project recovery pointer truncated for bootstrap]",
  );
  return {
    project,
    content,
    virtualPath: path.join(projectDir, "PROJECT_RECOVERY.md"),
  };
}

async function resolveSessionEntry(event: any): Promise<any> {
  const direct = sessionEntryFromEvent(event);
  if (direct?.sessionFile || direct?.sessionId) return direct;

  const sessionKey = event?.sessionKey || event?.context?.sessionKey;
  if (typeof sessionKey !== "string" || !sessionKey.trim()) return direct || {};

  const agentId = parseAgentId(sessionKey);
  const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
  const sessionsStore = await readJsonFile(path.join(sessionsDir, "sessions.json"));
  const storeEntry = sessionsStore?.sessions?.[sessionKey] || sessionsStore?.[sessionKey];
  if (!storeEntry?.sessionId) return direct || {};

  const sessionId = storeEntry.sessionId;
  const topicId = topicIdFromSessionKey(sessionKey);
  const candidates = topicId
    ? [
        path.join(sessionsDir, `${sessionId}-topic-${topicId}.jsonl`),
        path.join(sessionsDir, `${sessionId}.jsonl`),
      ]
    : [path.join(sessionsDir, `${sessionId}.jsonl`)];

  let sessionFile: string | undefined;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      sessionFile = candidate;
      break;
    } catch {
      // Try the next conventional transcript name.
    }
  }

  return {
    ...storeEntry,
    sessionId,
    sessionFile: sessionFile || storeEntry.sessionFile,
  };
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate: any = block;
    if (candidate.type === "text" && typeof candidate.text === "string") chunks.push(candidate.text);
  }
  return chunks.join("\n").trim() || undefined;
}

function metadataProvenance(entry: any): MessageProvenance | undefined {
  const message = entry?.message || {};
  const metadataObjects = [entry?.metadata, message.metadata].filter(
    (value) => value && typeof value === "object",
  );
  if (metadataObjects.some((metadata) => metadata.synthetic === true || metadata.systemGenerated === true)) {
    return "synthetic_system";
  }
  if (metadataObjects.some((metadata) => metadata.runtimeGenerated === true)) return "tool_or_runtime";

  const values: unknown[] = [entry?.source, entry?.provenance, message.source, message.provenance];
  for (const metadata of metadataObjects) {
    values.push(metadata.source, metadata.origin, metadata.kind, metadata.type, metadata.category, metadata.provenance);
  }

  const tags = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase().replace(/[ -]+/g, "_"));
  if (tags.some((tag) => new Set([
    "system",
    "synthetic",
    "synthetic_system",
    "gateway",
    "gateway_notice",
    "system_notice",
    "memory_flush",
    "compaction",
    "compact_handoff",
    "bootstrap",
    "approval_timeout",
  ]).has(tag))) return "synthetic_system";
  if (tags.some((tag) => new Set([
    "tool",
    "tool_result",
    "runtime",
    "command",
    "command_notification",
    "async_command",
    "async_command_notification",
  ]).has(tag))) return "tool_or_runtime";
  if (tags.includes("assistant")) return "assistant";
  if (tags.includes("real_user") || tags.includes("user")) return "real_user";
  return undefined;
}

function isNarrowSyntheticUserText(text: string): boolean {
  const normalized = text.trim();
  if (/^Approval request (?:[A-Za-z0-9_.:-]+ )?(?:timed out|expired)(?: before a response was received)?\.?$/i.test(normalized)) return true;
  if (/^Pre-compaction memory flush\. Store durable memories now\.?$/i.test(normalized)) return true;
  if (/^\[Async command (?:completed|notification)\]/i.test(normalized)) return true;
  if (/^Gateway (?:notice|system notice): (?:configuration reload completed|configuration reload failed|gateway restart completed|gateway startup completed)\.?$/i.test(normalized)) return true;
  return /^System (?:notice|notification): runtime maintenance completed\.?$/i.test(normalized);
}

function classifyMessageProvenance(entry: any, text: string): MessageProvenance {
  const message = entry?.message || {};
  const fromMetadata = metadataProvenance(entry);
  if (fromMetadata) return fromMetadata;

  const role = message.role;
  if (role === "system") return "synthetic_system";
  if (role === "tool" || role === "function") return "tool_or_runtime";
  if (role === "assistant") return "assistant";
  if (role === "user") return isNarrowSyntheticUserText(text) ? "synthetic_system" : "real_user";
  return "unknown";
}

function isRecursiveHandoffText(text: string): boolean {
  const normalized = text.trimStart();
  if (/^(?:# Compact Handoff|# Current Session Handoff — Compact Safe)(?:\r?\n|$)/i.test(normalized)) return true;
  if (/^(?:\[Compact Handoff Bootstrap\]|<compact-handoff-bootstrap>)(?:\r?\n|$)/i.test(normalized)) return true;
  return /^(?:#{1,6}[ \t]*)?(?:`{1,3})?memory\/session_handoffs\/[^\r\n`]+(?:`{1,3})?[ \t]*\r?\n(?:[ \t]*\r?\n)*# (?:Compact Handoff|Current Session Handoff — Compact Safe)(?:\r?\n|$)/i.test(normalized);
}

function utf16SafePrefix(text: string, maxChars: number): string {
  let end = Math.max(0, Math.min(text.length, Math.floor(maxChars)));
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  }
  return text.slice(0, end);
}

function clipUtf16Safe(text: string, maxChars: number, marker = "\n…[truncated]"): string {
  const cap = Math.max(0, Math.floor(maxChars));
  if (text.length <= cap) return text;
  const boundedMarker = utf16SafePrefix(marker, cap);
  return `${utf16SafePrefix(text, cap - boundedMarker.length)}${boundedMarker}`;
}

function clip(text: string, max = MAX_SINGLE_EVIDENCE_CHARS): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  return clipUtf16Safe(normalized, max, "\n…[evidence truncated]");
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/(service[_ -]?role[_ -]?key|api[_ -]?key|token|secret|password|bearer)\s*[:=]\s*["']?[^"'\s`]+/gi, "$1: [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(sk|ntn|sb|AIza)[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[REDACTED_LONG_TOKEN]");
}

async function readRecentMessages(sessionFile: string | undefined): Promise<TranscriptMessage[]> {
  if (!sessionFile) return [];
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    const recentTail: TranscriptMessage[] = [];
    let latestRealUser: TranscriptMessage | undefined;
    let latestAssistant: TranscriptMessage | undefined;
    let order = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || !entry.message) continue;
        const text = extractText(entry.message.content);
        if (!text || text.startsWith("/") || isRecursiveHandoffText(text)) continue;
        const transcriptMessage: TranscriptMessage = {
          provenance: classifyMessageProvenance(entry, text),
          text: clip(redactSensitiveText(text)),
          order,
        };
        order += 1;
        recentTail.push(transcriptMessage);
        if (recentTail.length > MAX_RECENT_MESSAGES) recentTail.shift();
        if (transcriptMessage.provenance === "real_user") latestRealUser = transcriptMessage;
        if (transcriptMessage.provenance === "assistant") latestAssistant = transcriptMessage;
      } catch {
        // Ignore malformed JSONL rows.
      }
    }
    const priorityMessages = [latestRealUser, latestAssistant].filter(
      (message): message is TranscriptMessage => Boolean(message),
    );
    const prioritySet = new Set(priorityMessages);
    const selected = [...recentTail];
    for (const priorityMessage of priorityMessages) {
      if (!selected.includes(priorityMessage)) selected.push(priorityMessage);
    }
    while (selected.length > MAX_RECENT_MESSAGES) {
      const removableIndex = selected.findIndex((message) => !prioritySet.has(message));
      if (removableIndex < 0) break;
      selected.splice(removableIndex, 1);
    }
    return selected.sort((left, right) => left.order - right.order);
  } catch (error) {
    logWarn("could not read recent messages", error);
    return [];
  }
}

function sessionScopedCurrentPath(handoffDir: string, sessionKeyOrId: string | undefined): string | undefined {
  if (!sessionKeyOrId || sessionKeyOrId === "unknown") return undefined;
  return path.join(handoffDir, `session_${safeSlug(sessionKeyOrId)}.MEMORY.md`);
}

function firstMatchingRecentMessage(recentMessages: TranscriptMessage[], provenance: MessageProvenance): string | undefined {
  for (const item of [...recentMessages].reverse()) {
    if (item.provenance === provenance) return item.text.split("\n").slice(0, 6).join("\n").trim();
  }
}

function detectCompletedSignals(recentMessages: TranscriptMessage[]): string[] {
  const signals: string[] = [];
  const patterns = [/已完成|完成|PASS|READY|commit|驗證|測試/i, /blocked|卡|error|失敗|風險/i];
  for (const item of [...recentMessages].reverse()) {
    const body = item.text;
    if (!patterns.some((pattern) => pattern.test(body))) continue;
    signals.push(clip(body, 500));
    if (signals.length >= 5) break;
  }
  return signals.reverse();
}

function buildWorkingState(recentMessages: TranscriptMessage[]): string[] {
  const latestUser = firstMatchingRecentMessage(recentMessages, "real_user");
  const latestAssistant = firstMatchingRecentMessage(recentMessages, "assistant");
  const signals = detectCompletedSignals(recentMessages);
  return [
    "## Deterministic Working State",
    ...(latestUser ? [`- Latest Real User Request: ${redactSensitiveText(latestUser)}`] : []),
    `- Latest assistant-facing status: ${latestAssistant ? redactSensitiveText(latestAssistant) : "unknown"}`,
    "- Most relevant recent signals:",
    ...(signals.length ? signals.map((signal) => `  - ${redactSensitiveText(signal).replace(/\n/g, " ")}`) : ["  - none detected"]),
    "",
  ];
}

function compactMetadataValue(value: unknown, maxChars = 240): string {
  const normalized = redactSensitiveText(String(value ?? "unknown")).replace(/\s+/g, " ").trim() || "unknown";
  return clipUtf16Safe(normalized, maxChars, "…[metadata truncated]");
}

function joinHandoffSections(sections: Array<string | undefined>): string {
  return `${sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n")}\n`;
}

function buildHandoff(params: {
  phase: "before" | "after" | "early";
  event: any;
  recentMessages: TranscriptMessage[];
  sessionEntry?: any;
  projectPointer?: string;
}): string {
  const { phase, event, recentMessages } = params;
  const context = event.context || {};
  const sessionEntry = params.sessionEntry || sessionEntryFromEvent(event);
  const timestamp = localTimestamp(new Date(event.timestamp || Date.now()));
  const sessionKey = event.sessionKey || context.sessionKey || "unknown";
  const sessionId = sessionEntry.sessionId || context.sessionId || "unknown";
  const sessionFile = sessionEntry.sessionFile || "unknown";
  const generationId = randomUUID();

  const stats = phase === "early"
    ? [
        `- phase: early-handoff`,
        `- totalTokens: ${compactMetadataValue(sessionEntry.totalTokens ?? context.tokenCount)}`,
        `- contextTokens: ${compactMetadataValue(sessionEntry.contextTokens)}`,
        `- triggerReason: ${compactMetadataValue(context.triggerReason ?? "threshold")}`,
      ]
    : phase === "before"
    ? [
        `- phase: pre-compaction`,
        `- messageCount: ${compactMetadataValue(context.messageCount)}`,
        `- tokenCount: ${compactMetadataValue(context.tokenCount)}`,
      ]
    : [
        `- phase: post-compaction`,
        `- compactedCount: ${compactMetadataValue(context.compactedCount)}`,
        `- summaryLength: ${compactMetadataValue(context.summaryLength)}`,
        `- tokensBefore: ${compactMetadataValue(context.tokensBefore)}`,
        `- tokensAfter: ${compactMetadataValue(context.tokensAfter)}`,
      ];

  const introduction = [
    "# Current Session Handoff — Compact Safe",
    "",
    "This file is auto-generated by the `compact-handoff` hook for this exact session. Read it after compaction/reset to recover continuity.",
    "",
    "## Recovery Priority",
    "- Continue the user's active task from the latest explicit instruction.",
    "- Preserve decisions, blockers, file paths, repo/branch/commit references, external service status, and next actions.",
    "- If this handoff conflicts with newer chat messages, newer chat messages win.",
    "- Do not expose secrets. Treat paths/tokens in transcripts carefully and redact before replying.",
  ].join("\n");
  const metadata = clipUtf16Safe([
    "## Session Metadata",
    "- schemaVersion: 2",
    `- generationId: ${generationId}`,
    `- generatedAt: ${timestamp}`,
    `- sessionKey: ${compactMetadataValue(sessionKey)}`,
    `- sessionId: ${compactMetadataValue(sessionId)}`,
    `- sessionFile: ${compactMetadataValue(sessionFile)}`,
    ...stats,
  ].join("\n"), 1800, "\n…[session metadata truncated]");
  const workingState = clipUtf16Safe(
    buildWorkingState(recentMessages).join("\n").trimEnd(),
    3600,
    "\n…[lower-priority working signals truncated]",
  );
  const omittedRecent = "## Recent Conversation Extract\n…[omitted first to honor the 8000-char handoff budget]";
  let projectPointer = params.projectPointer?.trimEnd();

  if (projectPointer) {
    const withoutProject = joinHandoffSections([introduction, metadata, workingState, omittedRecent]);
    const projectBudget = Math.max(0, Math.min(
      MAX_PROJECT_POINTER_CHARS,
      MAX_HANDOFF_BODY_CHARS - withoutProject.length - 2,
    ));
    projectPointer = clipUtf16Safe(
      projectPointer,
      projectBudget,
      "\n…[project pointer reduced after conversation extract omission]",
    );
  }

  const withoutRecent = joinHandoffSections([introduction, projectPointer, metadata, workingState]);
  const recentPrefix = "## Recent Conversation Extract\n";
  const recentBudget = Math.max(0, MAX_HANDOFF_BODY_CHARS - withoutRecent.length - 2 - recentPrefix.length);
  const recentRaw = recentMessages.length
    ? recentMessages.map((message) => `### ${message.provenance}\n${message.text}`).join("\n\n")
    : "No recent user/assistant messages could be recovered from the session transcript.";
  const recentExtract = `${recentPrefix}${clipUtf16Safe(
    recentRaw,
    recentBudget,
    "\n…[Recent Conversation Extract truncated first to honor handoff budget]",
  )}`;
  const rendered = joinHandoffSections([introduction, projectPointer, metadata, workingState, recentExtract]);
  if (rendered.length <= MAX_HANDOFF_BODY_CHARS) return rendered;

  // Defensive structure-aware fallback: preserve metadata and deterministic state,
  // rather than slicing from either end and discarding the handoff structure.
  return clipUtf16Safe(
    joinHandoffSections([introduction, metadata, workingState]),
    MAX_HANDOFF_BODY_CHARS,
    "\n…[lower-priority handoff sections omitted]",
  );
}

async function transcriptByteSize(sessionFile: string | undefined): Promise<number | undefined> {
  if (!sessionFile) return undefined;
  try {
    const stat = await fs.stat(sessionFile);
    return stat.size;
  } catch {
    return undefined;
  }
}

async function readEarlyState(handoffDir: string, sessionKeyOrId: string): Promise<any> {
  const statePath = path.join(handoffDir, `session_${safeSlug(sessionKeyOrId)}.state.json`);
  return (await readJsonFile(statePath)) || {};
}

async function writeEarlyState(handoffDir: string, sessionKeyOrId: string, state: any) {
  const statePath = path.join(handoffDir, `session_${safeSlug(sessionKeyOrId)}.state.json`);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateIndex(handoffDir: string, sessionKeyOrId: string, payload: any) {
  const indexPath = path.join(handoffDir, "index.json");
  const index = (await readJsonFile(indexPath)) || { sessions: {} };
  index.sessions ||= {};
  index.sessions[sessionKeyOrId] = {
    ...(index.sessions[sessionKeyOrId] || {}),
    ...payload,
    updatedAt: localTimestamp(),
  };
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

async function writeHandoff(event: any, phase: "before" | "after" | "early", resolvedEntry?: any) {
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  await fs.mkdir(handoffDir, { recursive: true });

  const sessionEntry = resolvedEntry || await resolveSessionEntry(event);
  const sessionKeyOrId = event.sessionKey || sessionEntry.sessionId || "unknown";
  const recentMessages = await readRecentMessages(sessionEntry.sessionFile);
  const projectPointer = await buildProjectRecoveryPointer(workspaceDir, sessionKeyOrId);
  const content = buildHandoff({ phase, event, recentMessages, sessionEntry, projectPointer: projectPointer?.content });
  const sessionSlug = safeSlug(sessionKeyOrId);
  const stamp = localTimestamp().replace(/[-:]/g, "");
  const archiveName = `${stamp}_${phase}_${sessionSlug}.md`;
  const archivePath = path.join(handoffDir, archiveName);
  const scopedCurrentPath = sessionScopedCurrentPath(handoffDir, sessionKeyOrId);

  await fs.writeFile(archivePath, content, "utf8");
  if (scopedCurrentPath) await fs.writeFile(scopedCurrentPath, content, "utf8");
  await updateIndex(handoffDir, sessionKeyOrId, {
    phase,
    project: projectPointer?.project,
    sessionId: sessionEntry.sessionId,
    sessionFile: sessionEntry.sessionFile,
    currentPath: scopedCurrentPath,
    archivePath,
    totalTokens: sessionEntry.totalTokens,
    contextTokens: sessionEntry.contextTokens,
  });
}

async function maybeWriteEarlyHandoff(event: any) {
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  await fs.mkdir(handoffDir, { recursive: true });

  const sessionEntry = await resolveSessionEntry(event);
  const sessionKeyOrId = event.sessionKey || sessionEntry.sessionId || "unknown";
  if (sessionKeyOrId === "unknown") return;

  const totalTokens = typeof sessionEntry.totalTokens === "number" ? sessionEntry.totalTokens : undefined;
  const contextTokens = typeof sessionEntry.contextTokens === "number" ? sessionEntry.contextTokens : undefined;
  const ratio = totalTokens && contextTokens ? totalTokens / contextTokens : 0;
  const byteSize = await transcriptByteSize(sessionEntry.sessionFile);
  const thresholdHit = ratio >= EARLY_TOKEN_RATIO || (byteSize ?? 0) >= EARLY_TRANSCRIPT_BYTES;
  if (!thresholdHit) return;

  const state = await readEarlyState(handoffDir, sessionKeyOrId);
  const now = Date.now();
  const lastAt = typeof state.lastEarlyAtMs === "number" ? state.lastEarlyAtMs : 0;
  const lastTokens = typeof state.lastEarlyTokens === "number" ? state.lastEarlyTokens : 0;
  const tokenDelta = totalTokens !== undefined ? totalTokens - lastTokens : 0;
  const shouldRefresh = ratio >= EARLY_FORCE_TOKEN_RATIO || !lastAt || now - lastAt >= EARLY_MIN_INTERVAL_MS || tokenDelta >= EARLY_MIN_TOKEN_DELTA;
  if (!shouldRefresh) return;

  event.context ||= {};
  event.context.triggerReason = ratio >= EARLY_TOKEN_RATIO ? `token-ratio-${ratio.toFixed(2)}` : `transcript-bytes-${byteSize}`;
  await writeHandoff(event, "early", sessionEntry);
  await writeEarlyState(handoffDir, sessionKeyOrId, {
    lastEarlyAtMs: now,
    lastEarlyAt: localTimestamp(new Date(now)),
    lastEarlyTokens: totalTokens,
    lastEarlyContextTokens: contextTokens,
    lastTranscriptBytes: byteSize,
    lastRatio: ratio,
  });
}

async function injectBootstrap(event: any) {
  const context = event.context || {};
  if (!Array.isArray(context.bootstrapFiles)) return;
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  await fs.mkdir(handoffDir, { recursive: true });
  const sessionKey = event.sessionKey || context.sessionKey;
  const currentPath = sessionScopedCurrentPath(handoffDir, sessionKey);
  let sessionBootstrapChars = 0;
  if (currentPath) {
    const alreadyInjected = context.bootstrapFiles.find((file: any) => file?.path === currentPath);
    if (alreadyInjected && typeof alreadyInjected.content === "string") {
      alreadyInjected.content = clipUtf16Safe(
        alreadyInjected.content,
        MAX_HANDOFF_BODY_CHARS,
        "\n…[legacy compact handoff truncated for bootstrap]",
      );
      sessionBootstrapChars = alreadyInjected.content.length;
    } else {
      let content: string | undefined;
      try {
        content = await fs.readFile(currentPath, "utf8");
      } catch {
        content = undefined;
      }
      if (content?.trim()) {
        content = clipUtf16Safe(
          content,
          MAX_HANDOFF_BODY_CHARS,
          "\n…[legacy compact handoff truncated for bootstrap]",
        );
        sessionBootstrapChars = content.length;
        context.bootstrapFiles = [
          ...context.bootstrapFiles,
          {
            name: "MEMORY.md",
            path: currentPath,
            content,
            missing: false,
          },
        ];
      }
    }
  }

  const projectPointer = await buildProjectRecoveryPointer(workspaceDir, sessionKey);
  if (!projectPointer?.content.trim()) return;
  const remainingBudget = Math.max(0, MAX_TOTAL_BOOTSTRAP_CHARS - sessionBootstrapChars);
  const projectBudget = Math.min(MAX_PROJECT_POINTER_CHARS, remainingBudget);
  if (projectBudget <= 0) return;
  const boundedProjectContent = clipUtf16Safe(
    projectPointer.content,
    projectBudget,
    "\n…[project pointer truncated for total bootstrap budget]",
  );
  if (!boundedProjectContent.trim()) return;
  const alreadyInjectedProject = context.bootstrapFiles.find(
    (file: any) => file?.path === projectPointer.virtualPath || file?.name === "PROJECT_RECOVERY.md",
  );
  if (alreadyInjectedProject) {
    alreadyInjectedProject.content = boundedProjectContent;
  } else {
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "PROJECT_RECOVERY.md",
        path: projectPointer.virtualPath,
        content: boundedProjectContent,
        missing: false,
      },
    ];
  }
  await updateIndex(handoffDir, sessionKey || "unknown", {
    project: projectPointer.project,
    lastProjectInjectedAt: localTimestamp(),
    projectRecoveryPath: projectPointer.virtualPath,
  });
}

const handler = async (event: any) => {
  try {
    if (event.type === "message" && event.action === "preprocessed") {
      await maybeWriteEarlyHandoff(event);
      return;
    }
    if (event.type === "session" && event.action === "compact:before") {
      await writeHandoff(event, "before");
      return;
    }
    if (event.type === "session" && event.action === "compact:after") {
      await writeHandoff(event, "after");
      return;
    }
    if (event.type === "agent" && event.action === "bootstrap") {
      await injectBootstrap(event);
    }
  } catch (error) {
    logWarn("handler failed", error);
  }
};

export default handler;
