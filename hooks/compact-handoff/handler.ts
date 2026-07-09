import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const HOOK_NAME = "compact-handoff";
const MAX_RECENT_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 1800;
const MAX_BOOTSTRAP_CHARS = 30000;
const EARLY_TOKEN_RATIO = 0.65;
const EARLY_FORCE_TOKEN_RATIO = 0.75;
const EARLY_MIN_TOKEN_DELTA = 10000;
const EARLY_MIN_INTERVAL_MS = 20 * 60 * 1000;
const EARLY_TRANSCRIPT_BYTES = 1500 * 1000;

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

function clip(text: string, max = MAX_MESSAGE_CHARS): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}\n…[truncated ${normalized.length - max} chars]`;
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/(service[_ -]?role[_ -]?key|api[_ -]?key|token|secret|password|bearer)\s*[:=]\s*["']?[^"'\s`]+/gi, "$1: [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(sk|ntn|sb|AIza)[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[REDACTED_LONG_TOKEN]");
}

async function readRecentMessages(sessionFile: string | undefined): Promise<string[]> {
  if (!sessionFile) return [];
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    const messages: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message" || !entry.message) continue;
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = extractText(entry.message.content);
        if (!text || text.startsWith("/")) continue;
        messages.push(`### ${role}\n${redactSensitiveText(clip(text))}`);
      } catch {
        // Ignore malformed JSONL rows.
      }
    }
    return messages.slice(-MAX_RECENT_MESSAGES);
  } catch (error) {
    logWarn("could not read recent messages", error);
    return [];
  }
}

function sessionScopedCurrentPath(handoffDir: string, sessionKeyOrId: string | undefined): string | undefined {
  if (!sessionKeyOrId || sessionKeyOrId === "unknown") return undefined;
  return path.join(handoffDir, `session_${safeSlug(sessionKeyOrId)}.MEMORY.md`);
}

async function readExistingForSession(handoffDir: string, sessionKeyOrId: string | undefined): Promise<string | undefined> {
  const scopedPath = sessionScopedCurrentPath(handoffDir, sessionKeyOrId);
  if (!scopedPath) return undefined;
  try {
    return await fs.readFile(scopedPath, "utf8");
  } catch {
    return undefined;
  }
}

function firstMatchingRecentMessage(recentMessages: string[], role: "user" | "assistant"): string | undefined {
  const prefix = `### ${role}\n`;
  for (const item of [...recentMessages].reverse()) {
    if (item.startsWith(prefix)) return item.slice(prefix.length).split("\n").slice(0, 6).join("\n").trim();
  }
}

function detectCompletedSignals(recentMessages: string[]): string[] {
  const signals: string[] = [];
  const patterns = [/已完成|完成|PASS|READY|commit|驗證|測試/i, /blocked|卡|error|失敗|風險/i];
  for (const item of [...recentMessages].reverse()) {
    const body = item.split("\n").slice(1).join("\n");
    if (!patterns.some((pattern) => pattern.test(body))) continue;
    signals.push(clip(body, 500));
    if (signals.length >= 5) break;
  }
  return signals.reverse();
}

function buildWorkingState(recentMessages: string[]): string[] {
  const latestUser = firstMatchingRecentMessage(recentMessages, "user");
  const latestAssistant = firstMatchingRecentMessage(recentMessages, "assistant");
  const signals = detectCompletedSignals(recentMessages);
  return [
    "## Deterministic Working State",
    `- Latest explicit user request: ${latestUser ? redactSensitiveText(latestUser) : "unknown"}`,
    `- Latest assistant-facing status: ${latestAssistant ? redactSensitiveText(latestAssistant) : "unknown"}`,
    "- Most relevant recent signals:",
    ...(signals.length ? signals.map((signal) => `  - ${redactSensitiveText(signal).replace(/\n/g, " ")}`) : ["  - none detected"]),
    "",
  ];
}

function buildHandoff(params: {
  phase: "before" | "after" | "early";
  event: any;
  recentMessages: string[];
  previous?: string;
  sessionEntry?: any;
}): string {
  const { phase, event, recentMessages, previous } = params;
  const context = event.context || {};
  const sessionEntry = params.sessionEntry || sessionEntryFromEvent(event);
  const timestamp = localTimestamp(new Date(event.timestamp || Date.now()));
  const sessionKey = event.sessionKey || context.sessionKey || "unknown";
  const sessionId = sessionEntry.sessionId || context.sessionId || "unknown";
  const sessionFile = sessionEntry.sessionFile || "unknown";

  const stats = phase === "early"
    ? [
        `- phase: early-handoff`,
        `- totalTokens: ${sessionEntry.totalTokens ?? context.tokenCount ?? "unknown"}`,
        `- contextTokens: ${sessionEntry.contextTokens ?? "unknown"}`,
        `- triggerReason: ${context.triggerReason ?? "threshold"}`,
      ]
    : phase === "before"
    ? [
        `- phase: pre-compaction`,
        `- messageCount: ${context.messageCount ?? "unknown"}`,
        `- tokenCount: ${context.tokenCount ?? "unknown"}`,
      ]
    : [
        `- phase: post-compaction`,
        `- compactedCount: ${context.compactedCount ?? "unknown"}`,
        `- summaryLength: ${context.summaryLength ?? "unknown"}`,
        `- tokensBefore: ${context.tokensBefore ?? "unknown"}`,
        `- tokensAfter: ${context.tokensAfter ?? "unknown"}`,
      ];

  const previousBrief = previous
    ? previous.split("\n").slice(0, 80).join("\n")
    : "No previous handoff found.";

  return [
    "# Current Session Handoff — Compact Safe",
    "",
    "This file is auto-generated by the `compact-handoff` hook for this exact session. Read it after compaction/reset to recover continuity.",
    "",
    "## Recovery Priority",
    "- Continue the user's active task from the latest explicit instruction.",
    "- Preserve decisions, blockers, file paths, repo/branch/commit references, external service status, and next actions.",
    "- If this handoff conflicts with newer chat messages, newer chat messages win.",
    "- Do not expose secrets. Treat paths/tokens in transcripts carefully and redact before replying.",
    "",
    "## Session Metadata",
    `- generatedAt: ${timestamp}`,
    `- sessionKey: ${sessionKey}`,
    `- sessionId: ${sessionId}`,
    `- sessionFile: ${sessionFile}`,
    ...stats,
    "",
    ...buildWorkingState(recentMessages),
    "## Operator Fill-in Checklist for the Next Turn",
    "- Current goal:",
    "- Last completed step:",
    "- Current blocker:",
    "- Next concrete action:",
    "- Files/repos/branches/commits involved:",
    "- Tests or evidence already collected:",
    "- Risks / do-not-do items:",
    "",
    "## Previous Handoff Snapshot",
    previousBrief,
    "",
    "## Recent Conversation Extract",
    recentMessages.length ? recentMessages.join("\n\n") : "No recent user/assistant messages could be recovered from the session transcript.",
    "",
  ].join("\n");
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
  const previous = await readExistingForSession(handoffDir, sessionKeyOrId);
  const content = buildHandoff({ phase, event, recentMessages, previous, sessionEntry });
  const sessionSlug = safeSlug(sessionKeyOrId);
  const stamp = localTimestamp().replace(/[-:]/g, "");
  const archiveName = `${stamp}_${phase}_${sessionSlug}.md`;
  const archivePath = path.join(handoffDir, archiveName);
  const scopedCurrentPath = sessionScopedCurrentPath(handoffDir, sessionKeyOrId);

  await fs.writeFile(archivePath, content, "utf8");
  if (scopedCurrentPath) await fs.writeFile(scopedCurrentPath, content, "utf8");
  await updateIndex(handoffDir, sessionKeyOrId, {
    phase,
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
  const currentPath = sessionScopedCurrentPath(handoffDir, event.sessionKey || context.sessionKey);
  if (!currentPath) return;
  let content: string;
  try {
    content = await fs.readFile(currentPath, "utf8");
  } catch {
    return;
  }
  if (!content.trim()) return;
  if (content.length > MAX_BOOTSTRAP_CHARS) {
    content = `${content.slice(0, MAX_BOOTSTRAP_CHARS)}\n\n…[compact handoff truncated for bootstrap]`;
  }
  const alreadyInjected = context.bootstrapFiles.some((file: any) => file?.path === currentPath);
  if (alreadyInjected) return;
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
