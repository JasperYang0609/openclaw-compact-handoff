import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";

const HOOK_NAME = "compact-handoff";
const MAX_RECENT_MESSAGES = 24;
const MAX_SINGLE_EVIDENCE_CHARS = 1200;
const MAX_HANDOFF_BODY_CHARS = 8000;
const MAX_CURRENT_HANDOFF_FILE_BYTES = MAX_HANDOFF_BODY_CHARS * 4;
const MAX_PROJECT_POINTER_CHARS = 2000;
const MAX_TOTAL_BOOTSTRAP_CHARS = 10000;
const MAX_EXACT_REFERENCES = 20;
const MAX_SESSION_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_SUMMARY_CHARS = 16000;
const MAX_STATE_FILE_BYTES = 32 * 1024;
const MAX_INDEX_FILE_BYTES = 512 * 1024;
const MAX_SESSIONS_STORE_BYTES = 8 * 1024 * 1024;
const STATE_CORRUPT_RETENTION_COUNT = 3;
const STATE_CORRUPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_SUMMARY_REQUIRED_SECTIONS = [
  "Decisions",
  "Open TODOs",
  "Constraints/Rules",
  "Pending user asks",
  "Exact identifiers",
] as const;
const EARLY_TOKEN_RATIO = 0.65;
const EARLY_FORCE_TOKEN_RATIO = 0.75;
const EARLY_MIN_TOKEN_DELTA = 10000;
const EARLY_HARD_MIN_INTERVAL_MS = 5 * 60 * 1000;
const EARLY_REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const EARLY_TRANSCRIPT_BYTES = 1500 * 1000;
const ARCHIVE_RETENTION_PER_PHASE = 5;
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_INSTANCE_SEPARATOR = "@";
const ARCHIVE_INSTANCE_SUFFIX_PATTERN = /^@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDOFF_INJECTION_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_INJECTION_MODE = "single-bootstrap-no-delivery-correlation";
const FILE_LOCK_WAIT_MS = 5000;
const FILE_LOCK_STALE_MS = 2 * 60 * 1000;
const FILE_LOCK_RETRY_MS = 10;

type MessageProvenance = "real_user" | "assistant" | "synthetic_system" | "tool_or_runtime" | "unknown";

type TranscriptMessage = {
  provenance: MessageProvenance;
  text: string;
  order: number;
};

type SessionTail = {
  available: boolean;
  text: string;
  truncatedAtStart: boolean;
  reason?: string;
};

type FileIdentity = {
  dev: number;
  ino: number;
};

type NativeSummaryAudit = {
  available: boolean;
  ok?: boolean;
  reasons: string[];
  summaryLength?: number;
};

function logWarn(message: string, error?: unknown) {
  let code: string | undefined;
  if (typeof error === "object" && error && "code" in error && typeof (error as any).code === "string") {
    code = (error as any).code;
  } else if (error instanceof SyntaxError) {
    code = "SyntaxError";
  } else if (error instanceof Error) {
    code = "Error";
  } else if (error) {
    code = "unknown-error";
  }
  console.warn(`[${HOOK_NAME}] ${message}${code ? ` (${code})` : ""}`);
}

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180) || "unknown";
}

function sessionStorageSlug(value: string): string {
  const original = String(value || "unknown");
  const readable = safeSlug(original);
  if (readable === original && original.length <= 180) return readable;
  const digest = createHash("sha256").update(original, "utf8").digest("hex").slice(0, 32);
  return `${readable.slice(0, 120)}~${digest}`;
}

function safePathComponent(input: unknown, maxLength = 180): string | undefined {
  if (typeof input !== "string" || input.length < 1 || input.length > maxLength) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) ? input : undefined;
}

function parseAgentId(sessionKey: string | undefined): string | undefined {
  const match = typeof sessionKey === "string" ? sessionKey.match(/^agent:([^:]+):/) : undefined;
  return safePathComponent(match?.[1], 80);
}

function topicIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== "string") return undefined;
  const parts = sessionKey.split(":");
  return parts.length >= 5 ? safePathComponent(parts[parts.length - 1], 128) : undefined;
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

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Some filesystems do not support fsync on directories. The file itself is
    // still synced before rename, so this is a durability enhancement only.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.tmp-${Date.now()}-${process.pid}-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    await syncDirectory(dirPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function fileLockError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function lockOwnerAppearsAlive(lockPath: string): Promise<boolean | undefined> {
  let raw: string;
  try {
    const lockFile = await readBoundedRegularFile(lockPath, 4096);
    raw = lockFile.text;
  } catch {
    return undefined;
  }
  let pid: unknown;
  try {
    pid = JSON.parse(raw).pid;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return undefined;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

type FilesystemLockClaim = {
  handle: Awaited<ReturnType<typeof fs.open>>;
  identity: FileIdentity;
};

function assertSafeLockArtifact(stat: any) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile()
      || stat.isSymbolicLink()
      || (currentUid !== undefined && stat.uid !== currentUid)
      || (stat.mode & 0o077) !== 0
      || stat.size > 4096) {
    throw fileLockError("unsafe compact-handoff lock file", "ELOCKUNSAFE");
  }
}

async function removeFilesystemLockIfOwned(
  lockPath: string,
  expectedIdentity: FileIdentity,
): Promise<boolean> {
  let current: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    current = await fs.lstat(lockPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino) return false;
  await fs.unlink(lockPath);
  await syncDirectory(path.dirname(lockPath));
  return true;
}

async function recoveryMarkerBlocks(recoveryPath: string): Promise<boolean> {
  let marker: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    marker = await fs.lstat(recoveryPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  assertSafeLockArtifact(marker);
  const ownerAlive = await lockOwnerAppearsAlive(recoveryPath);
  if (ownerAlive === false) {
    throw fileLockError(
      "stale compact-handoff recovery marker requires manual removal",
      "ELOCKRECOVERY",
    );
  }
  if (ownerAlive === undefined && Date.now() - marker.mtimeMs >= FILE_LOCK_STALE_MS) {
    throw fileLockError("invalid compact-handoff recovery marker", "ELOCKUNSAFE");
  }
  return true;
}

async function createRecoveryClaim(
  recoveryPath: string,
  targetIdentity: FileIdentity,
): Promise<FilesystemLockClaim | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: FileIdentity | undefined;
  try {
    handle = await fs.open(
      recoveryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, 4096);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      targetDev: targetIdentity.dev,
      targetIno: targetIdentity.ino,
    })}\n`, "utf8");
    await handle.sync();
    await syncDirectory(path.dirname(recoveryPath));
    return { handle, identity };
  } catch (error: any) {
    await handle?.close().catch(() => undefined);
    if (identity) await removeFilesystemLockIfOwned(recoveryPath, identity).catch(() => undefined);
    if (error?.code === "EEXIST") return undefined;
    throw error;
  }
}

async function releaseFilesystemLockClaim(
  lockPath: string,
  claim: FilesystemLockClaim,
): Promise<void> {
  await claim.handle.close().catch(() => undefined);
  await removeFilesystemLockIfOwned(lockPath, claim.identity);
}

async function withFilesystemLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const recoveryPath = `${lockPath}.recovery`;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let lockIdentity: FileIdentity | undefined;
  while (!handle) {
    if (await recoveryMarkerBlocks(recoveryPath)) {
      if (Date.now() - startedAt >= FILE_LOCK_WAIT_MS) {
        throw fileLockError("timed out waiting for compact-handoff lock recovery", "ELOCKTIMEOUT");
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      continue;
    }

    let createdInAttempt = false;
    let attemptIdentity: FileIdentity | undefined;
    lockIdentity = undefined;
    try {
      const createdHandle = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      handle = createdHandle;
      createdInAttempt = true;
      const stat = await createdHandle.stat();
      assertSafeRegularFileStat(stat, 4096);
      attemptIdentity = { dev: stat.dev, ino: stat.ino };
      lockIdentity = attemptIdentity;
      await createdHandle.writeFile(`${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() })}\n`, "utf8");
      await createdHandle.sync();
      await syncDirectory(path.dirname(lockPath));

      // A reaper can appear after the pre-open marker check. Never enter the
      // protected task until the marker is absent both before and after create.
      if (await recoveryMarkerBlocks(recoveryPath)) {
        await createdHandle.close().catch(() => undefined);
        handle = undefined;
        await removeFilesystemLockIfOwned(lockPath, attemptIdentity);
        createdInAttempt = false;
        lockIdentity = undefined;
        if (Date.now() - startedAt >= FILE_LOCK_WAIT_MS) {
          throw fileLockError("timed out waiting for compact-handoff lock recovery", "ELOCKTIMEOUT");
        }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
        continue;
      }
    } catch (error: any) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (createdInAttempt && attemptIdentity) {
        await removeFilesystemLockIfOwned(lockPath, attemptIdentity).catch(() => undefined);
      }
      lockIdentity = undefined;
      if (error?.code !== "EEXIST") throw error;

      let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        existing = await fs.lstat(lockPath);
      } catch (lstatError: any) {
        if (lstatError?.code === "ENOENT") continue;
        throw lstatError;
      }
      if (!existing) continue;
      assertSafeLockArtifact(existing);

      if (Date.now() - existing.mtimeMs >= FILE_LOCK_STALE_MS) {
        const ownerAlive = await lockOwnerAppearsAlive(lockPath);
        if (ownerAlive === false) {
          const targetIdentity = { dev: existing.dev, ino: existing.ino };
          const recoveryClaim = await createRecoveryClaim(recoveryPath, targetIdentity);
          if (recoveryClaim) {
            try {
              let latest: Awaited<ReturnType<typeof fs.lstat>> | undefined;
              try {
                latest = await fs.lstat(lockPath);
              } catch (latestError: any) {
                if (latestError?.code === "ENOENT") continue;
                throw latestError;
              }
              if (!latest) continue;
              if (latest.dev !== targetIdentity.dev
                  || latest.ino !== targetIdentity.ino
                  || Date.now() - latest.mtimeMs < FILE_LOCK_STALE_MS) {
                continue;
              }
              const latestOwnerAlive = await lockOwnerAppearsAlive(lockPath);
              if (latestOwnerAlive !== false) continue;
              await fs.unlink(lockPath).catch((unlinkError: any) => {
                if (unlinkError?.code !== "ENOENT") throw unlinkError;
              });
              await syncDirectory(path.dirname(lockPath));
            } finally {
              await releaseFilesystemLockClaim(recoveryPath, recoveryClaim);
            }
            continue;
          }
        }
      }
      if (Date.now() - startedAt >= FILE_LOCK_WAIT_MS) {
        throw fileLockError("timed out waiting for compact-handoff lock", "ELOCKTIMEOUT");
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
    }
  }
  const acquiredHandle = handle;
  const acquiredIdentity = lockIdentity;
  if (!acquiredIdentity) {
    await acquiredHandle.close().catch(() => undefined);
    throw fileLockError("compact-handoff lock identity unavailable", "ELOCKINVALID");
  }
  try {
    return await task();
  } finally {
    await acquiredHandle.close().catch(() => undefined);
    try {
      const removed = await removeFilesystemLockIfOwned(lockPath, acquiredIdentity);
      if (!removed) {
        logWarn("compact-handoff lock ownership changed before release", fileLockError(
          "compact-handoff lock ownership changed before release",
          "ELOCKLOST",
        ));
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") logWarn("failed to release compact-handoff lock", error);
    }
  }
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

function safeRuntimeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
      return value;
    }
  }
  return undefined;
}

function pathIsInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function trustedSessionsDirectory(agentId: string): Promise<string | undefined> {
  const homeDir = os.homedir();
  const components = [".openclaw", "agents", agentId, "sessions"];
  let currentPath = homeDir;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  try {
    for (const component of components) {
      currentPath = path.join(currentPath, component);
      const stat = await fs.lstat(currentPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      if (currentUid !== undefined && stat.uid !== currentUid) return undefined;
      if ((stat.mode & 0o022) !== 0) return undefined;
    }
    const agentsRoot = path.join(homeDir, ".openclaw", "agents");
    const agentsRootReal = await fs.realpath(agentsRoot);
    const sessionsReal = await fs.realpath(currentPath);
    if (!pathIsInside(agentsRootReal, sessionsReal)) return undefined;
    return currentPath;
  } catch {
    return undefined;
  }
}

async function trustedConventionalTranscript(
  sessionsDir: string,
  candidates: string[],
): Promise<{ filePath: string; realPath: string; identity: FileIdentity } | undefined> {
  try {
    const directoryStat = await fs.lstat(sessionsDir);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return undefined;
    const sessionsDirReal = await fs.realpath(sessionsDir);
    for (const candidate of candidates) {
      try {
        const candidateStat = await fs.lstat(candidate);
        const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) continue;
        if (currentUid !== undefined && candidateStat.uid !== currentUid) continue;
        if ((candidateStat.mode & 0o022) !== 0) continue;
        const candidateReal = await fs.realpath(candidate);
        if (!pathIsInside(sessionsDirReal, candidateReal)) continue;
        return {
          filePath: candidate,
          realPath: candidateReal,
          identity: { dev: candidateStat.dev, ino: candidateStat.ino },
        };
      } catch {
        // Try the next conventional transcript name.
      }
    }
  } catch {
    // Missing or unsafe sessions directory means transcript unavailable.
  }
  return undefined;
}

async function resolveSessionEntry(event: any): Promise<any> {
  const direct = sessionEntryFromEvent(event);
  const sessionKey = event?.sessionKey || event?.context?.sessionKey;
  const safeMetadata = {
    totalTokens: safeRuntimeNumber(direct?.totalTokens),
    contextTokens: safeRuntimeNumber(direct?.contextTokens),
  };
  if (typeof sessionKey !== "string"
      || !sessionKey.trim()
      || sessionKey.length > 512
      || /[\u0000-\u001f\u007f]/.test(sessionKey)) {
    return safeMetadata;
  }

  const agentId = parseAgentId(sessionKey);
  const parts = sessionKey.split(":");
  const topicId = topicIdFromSessionKey(sessionKey);
  if (!agentId) return safeMetadata;
  if (parts.length >= 5 && !topicId) return safeMetadata;

  const sessionsDir = await trustedSessionsDirectory(agentId);
  if (!sessionsDir) return safeMetadata;
  let sessionsStore: any;
  try {
    sessionsStore = await readCachedSessionsStore(path.join(sessionsDir, "sessions.json"));
  } catch {
    return safeMetadata;
  }
  const storeEntry = sessionsStore?.sessions?.[sessionKey] || sessionsStore?.[sessionKey];
  const sessionId = safePathComponent(storeEntry?.sessionId, 180);
  if (!sessionId) return safeMetadata;

  const candidates = topicId
    ? [
        path.join(sessionsDir, `${sessionId}-topic-${topicId}.jsonl`),
        path.join(sessionsDir, `${sessionId}.jsonl`),
      ]
    : [path.join(sessionsDir, `${sessionId}.jsonl`)];
  const trustedTranscript = await trustedConventionalTranscript(sessionsDir, candidates);
  const resolved = {
    sessionId,
    totalTokens: safeRuntimeNumber(direct?.totalTokens, storeEntry?.totalTokens),
    contextTokens: safeRuntimeNumber(direct?.contextTokens, storeEntry?.contextTokens),
    sessionFile: undefined as string | undefined,
    sessionFileIdentity: undefined as FileIdentity | undefined,
  };
  if (!trustedTranscript) return resolved;

  if (direct?.sessionId !== undefined && direct.sessionId !== sessionId) return resolved;
  if (direct?.sessionFile !== undefined) {
    if (typeof direct.sessionFile !== "string"
        || direct.sessionFile !== trustedTranscript.filePath) {
      return resolved;
    }
    try {
      const directStat = await fs.lstat(direct.sessionFile);
      if (!directStat.isFile() || directStat.isSymbolicLink()) return resolved;
      if (directStat.dev !== trustedTranscript.identity.dev
          || directStat.ino !== trustedTranscript.identity.ino) return resolved;
      if (await fs.realpath(direct.sessionFile) !== trustedTranscript.realPath) return resolved;
    } catch {
      return resolved;
    }
  }

  resolved.sessionFile = trustedTranscript.filePath;
  resolved.sessionFileIdentity = trustedTranscript.identity;
  return resolved;
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

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

type CredentialHeaderValueSpan = {
  valueEnd: number;
  replacementSuffix: string;
};

function shellContinuationBefore(input: string, newlineIndex: number): boolean {
  let cursor = newlineIndex - 1;
  if (cursor >= 0 && input[cursor] === "\r") cursor -= 1;
  let backslashes = 0;
  while (cursor >= 0 && input[cursor] === "\\") {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}

function headerContinuesAfterNewline(input: string, newlineIndex: number): boolean {
  const continuationStart = newlineIndex + 1;
  return input[continuationStart] === " "
    || input[continuationStart] === "\t"
    || shellContinuationBefore(input, newlineIndex);
}

function continuedHeaderValueEnd(input: string, firstNewlineIndex: number): number {
  let newlineIndex = firstNewlineIndex;
  while (headerContinuesAfterNewline(input, newlineIndex)) {
    const nextNewlineIndex = input.indexOf("\n", newlineIndex + 1);
    if (nextNewlineIndex < 0) return input.length;
    newlineIndex = nextNewlineIndex;
  }
  return newlineIndex;
}

function shellLineSplicesEnd(input: string, start: number): number {
  let cursor = start;
  while (input[cursor] === "\\") {
    if (input[cursor + 1] === "\n") {
      cursor += 2;
      continue;
    }
    if (input[cursor + 1] === "\r" && input[cursor + 2] === "\n") {
      cursor += 3;
      continue;
    }
    break;
  }
  return cursor;
}

function startsDynamicShellExpansion(input: string, index: number): boolean {
  const char = input[index];
  if (char === "`") return true;
  if (char !== "$" && char !== "<" && char !== ">") return false;
  const next = input[shellLineSplicesEnd(input, index + 1)];
  return (char === "$" && (next === "(" || next === "{"))
    || ((char === "<" || char === ">") && next === "(");
}

function shellWordEnd(input: string, start: number): number {
  let quote: string | undefined;
  let cursor = start;
  while (cursor < input.length) {
    const char = input[cursor];
    if (startsDynamicShellExpansion(input, cursor)) return input.length;
    if (quote) {
      if (char === quote && !isEscapedAt(input, cursor)) quote = undefined;
      cursor += 1;
      continue;
    }
    if ((char === "\"" || char === "'") && !isEscapedAt(input, cursor)) {
      quote = char;
      cursor += 1;
      continue;
    }
    if (char === "\\") {
      if (input[cursor + 1] === "\n") {
        cursor += 2;
        continue;
      }
      if (input[cursor + 1] === "\r" && input[cursor + 2] === "\n") {
        cursor += 3;
        continue;
      }
      cursor += cursor + 1 < input.length ? 2 : 1;
      continue;
    }
    if (/\s/.test(char)) return cursor;
    cursor += 1;
  }
  return input.length;
}

function hasShellAdjacency(input: string, index: number): boolean {
  const char = input[index];
  return Boolean(char) && !/\s/.test(char);
}

function credentialHeaderValueSpan(
  input: string,
  valueStart: number,
  enclosingQuote?: string,
): CredentialHeaderValueSpan {
  if (enclosingQuote) {
    for (let index = valueStart; index < input.length; index += 1) {
      if (startsDynamicShellExpansion(input, index)) {
        return {
          valueEnd: input.length,
          replacementSuffix: enclosingQuote,
        };
      }
      if (input[index] !== enclosingQuote || isEscapedAt(input, index)) continue;
      const afterClosingQuote = index + 1;
      const nextNewlineIndex = input.indexOf("\n", afterClosingQuote);
      if (nextNewlineIndex >= 0 && headerContinuesAfterNewline(input, nextNewlineIndex)) {
        return {
          valueEnd: continuedHeaderValueEnd(input, nextNewlineIndex),
          replacementSuffix: enclosingQuote,
        };
      }
      if (hasShellAdjacency(input, afterClosingQuote)) {
        return {
          valueEnd: shellWordEnd(input, afterClosingQuote),
          replacementSuffix: enclosingQuote,
        };
      }
      return { valueEnd: index, replacementSuffix: "" };
    }
    return { valueEnd: input.length, replacementSuffix: "" };
  }

  const newlineIndex = input.indexOf("\n", valueStart);
  if (newlineIndex < 0) return { valueEnd: input.length, replacementSuffix: "" };
  const continuedEnd = continuedHeaderValueEnd(input, newlineIndex);
  if (continuedEnd !== newlineIndex) {
    return {
      valueEnd: continuedEnd,
      replacementSuffix: "",
    };
  }
  return { valueEnd: newlineIndex, replacementSuffix: "" };
}

function redactCookieHeaders(input: string): string {
  const headerPattern = /(?:(["'])(?:Cookie|Set-Cookie)\1|\b(?:Cookie|Set-Cookie)\b)\s*[:=]\s*/gi;
  let output = "";
  let cursor = 0;
  while (true) {
    headerPattern.lastIndex = cursor;
    const match = headerPattern.exec(input);
    if (!match) break;
    const valueStart = headerPattern.lastIndex;
    const valueQuote = (input[valueStart] === "\"" || input[valueStart] === "'")
        && !isEscapedAt(input, valueStart)
      ? input[valueStart]
      : undefined;
    const preceding = match.index > 0 ? input[match.index - 1] : undefined;
    const outerQuote = !valueQuote && (preceding === "\"" || preceding === "'")
      ? preceding
      : undefined;
    const enclosingQuote = valueQuote || outerQuote;
    const replacementStart = valueQuote ? valueStart + 1 : valueStart;
    const { valueEnd, replacementSuffix } = credentialHeaderValueSpan(
      input,
      replacementStart,
      enclosingQuote,
    );
    output += `${input.slice(cursor, replacementStart)}[REDACTED]${replacementSuffix}`;
    cursor = valueEnd;
  }
  return `${output}${input.slice(cursor)}`;
}

function redactAuthorizationHeaders(input: string): string {
  const headerPattern = /(?:(["'])(?:Proxy-)?Authorization\1|\b(?:Proxy-)?Authorization\b)\s*[:=]\s*/gi;
  let output = "";
  let cursor = 0;
  while (true) {
    headerPattern.lastIndex = cursor;
    const match = headerPattern.exec(input);
    if (!match) break;
    const valueStart = headerPattern.lastIndex;
    const valueQuote = (input[valueStart] === "\"" || input[valueStart] === "'")
        && !isEscapedAt(input, valueStart)
      ? input[valueStart]
      : undefined;
    const preceding = match.index > 0 ? input[match.index - 1] : undefined;
    const outerQuote = !valueQuote && (preceding === "\"" || preceding === "'")
      ? preceding
      : undefined;
    const enclosingQuote = valueQuote || outerQuote;
    const replacementStart = valueQuote ? valueStart + 1 : valueStart;
    const { valueEnd, replacementSuffix } = credentialHeaderValueSpan(
      input,
      replacementStart,
      enclosingQuote,
    );
    output += `${input.slice(cursor, replacementStart)}[REDACTED]${replacementSuffix}`;
    cursor = valueEnd;
  }
  return `${output}${input.slice(cursor)}`;
}

function hasShellSplicedCredentialAssignment(input: string): boolean {
  let lastSpliceOffset = -1;
  let removedLength = 0;
  const normalized = input.replace(/\\(?:\r\n|\n)/g, (splice, offset: number) => {
    lastSpliceOffset = offset - removedLength;
    removedLength += splice.length;
    return "";
  });
  if (lastSpliceOffset < 0) return false;
  const assignmentPattern = /(?:(["'])(?:(?:Proxy-)?Authorization|(?:Set-)?Cookie)\1|\b(?:(?:Proxy-)?Authorization|(?:Set-)?Cookie)\b)\s*[:=]\s*/i;
  const firstAssignment = assignmentPattern.exec(normalized);
  return firstAssignment !== null && firstAssignment.index <= lastSpliceOffset;
}

function redactHeaderText(input: string): string {
  if (hasShellSplicedCredentialAssignment(input)) return "[REDACTED_SHELL_SPLICED_HEADER]";
  return redactAuthorizationHeaders(redactCookieHeaders(input));
}

const MAX_STRUCTURED_REDACTION_DEPTH = 64;
const CREDENTIAL_HEADER_KEY = /^(?:(?:Proxy-)?Authorization|(?:Set-)?Cookie)$/i;

function parseJsonValue(input: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(input) as unknown };
  } catch {
    return undefined;
  }
}

function sanitizeStructuredJsonValue(value: unknown, depth: number): unknown {
  if (depth > MAX_STRUCTURED_REDACTION_DEPTH) return "[REDACTED_STRUCTURED_DEPTH]";
  if (typeof value === "string") {
    const nested = parseJsonValue(value);
    if (!nested) return redactHeaderText(value);
    if (nested.value === null
        || (typeof nested.value !== "object" && typeof nested.value !== "string")) {
      return redactHeaderText(value);
    }
    try {
      return JSON.stringify(sanitizeStructuredJsonValue(nested.value, depth + 1))
        ?? "[REDACTED_STRUCTURED_DATA]";
    } catch {
      return "[REDACTED_STRUCTURED_DATA]";
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredJsonValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      output[key] = CREDENTIAL_HEADER_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeStructuredJsonValue(entry, depth + 1);
    }
    return output;
  }
  return value;
}

function redactStructuredHeaderData(input: string): string | undefined {
  const parsed = parseJsonValue(input);
  if (!parsed) return undefined;
  try {
    return JSON.stringify(sanitizeStructuredJsonValue(parsed.value, 0))
      ?? "[REDACTED_STRUCTURED_DATA]";
  } catch {
    return "[REDACTED_STRUCTURED_DATA]";
  }
}

function redactSensitiveText(input: string): string {
  return (redactStructuredHeaderData(input) ?? redactHeaderText(input))
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/(["'](?:service[_ -]?role[_ -]?key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|bearer)["']\s*:\s*)["'][^"'\r\n]+["']/gi, "$1\"[REDACTED]\"")

    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bxox[a-zA-Z]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(service[_ -]?role[_ -]?key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|bearer)\s*[:=]\s*["']?[^"'\s`]+/gi, "$1: [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(sk|ntn|sb|AIza)[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[REDACTED_LONG_TOKEN]");
}

async function readSessionTail(
  sessionFile: string | undefined,
  expectedIdentity?: FileIdentity,
): Promise<SessionTail> {
  if (!sessionFile) {
    return {
      available: false,
      text: "",
      truncatedAtStart: false,
      reason: "session-file-unavailable",
    };
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(sessionFile, noFollowReadFlags());
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, Number.MAX_SAFE_INTEGER);
    assertFileIdentity(stat, expectedIdentity);
    const bytesToRead = Math.min(stat.size, MAX_SESSION_TAIL_BYTES);
    const start = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const result = await handle.read(buffer, bytesRead, bytesToRead - bytesRead, start + bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const postReadStat = await handle.stat();
    assertStableFileSnapshot(stat, postReadStat, Number.MAX_SAFE_INTEGER);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      available: true,
      text,
      truncatedAtStart: start > 0,
    };
  } catch (error: any) {
    logWarn("could not read bounded session tail", error);
    return {
      available: false,
      text: "",
      truncatedAtStart: false,
      reason: error?.code === "ENOENT" ? "session-file-unavailable" : "session-tail-read-failed",
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseRecentMessages(raw: string): TranscriptMessage[] {
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
}

function sessionScopedCurrentPath(handoffDir: string, sessionKeyOrId: string | undefined): string | undefined {
  if (!sessionKeyOrId || sessionKeyOrId === "unknown") return undefined;
  return path.join(handoffDir, `session_${sessionStorageSlug(sessionKeyOrId)}.MEMORY.md`);
}

function sessionScopedStatePath(handoffDir: string, sessionKeyOrId: string): string {
  return path.join(handoffDir, `session_${sessionStorageSlug(sessionKeyOrId)}.state.json`);
}

function validatedHandoffGenerationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-[0-9a-f]{32})$/i.test(value)
    ? value
    : undefined;
}

function handoffGenerationId(content: string): string {
  const generationId = validatedHandoffGenerationId(content.match(/^- generationId: ([^\s\r\n]+)$/m)?.[1]);
  if (generationId) return generationId;
  return `legacy-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32)}`;
}

function archiveBelongsToSession(scopedName: string, sessionStorageId: string): boolean {
  if (scopedName === sessionStorageId) return true;
  if (!scopedName.startsWith(sessionStorageId)) return false;
  return ARCHIVE_INSTANCE_SUFFIX_PATTERN.test(scopedName.slice(sessionStorageId.length));
}

function firstMatchingRecentMessage(recentMessages: TranscriptMessage[], provenance: MessageProvenance): string | undefined {
  for (const item of [...recentMessages].reverse()) {
    if (item.provenance === provenance) return item.text.split("\n").slice(0, 6).join("\n").trim();
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectExactReferences(recentMessages: TranscriptMessage[]): string[] {
  const references = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s<>"'`]+/g,
    /(?:\/[A-Za-z0-9._~:@%+=,-]+){2,}/g,
    /\b[0-9a-f]{7,40}\b/gi,
    /\b\d{17,20}\b/g,
  ];
  for (const message of recentMessages) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of message.text.matchAll(pattern)) {
        references.add(match[0]);
        if (references.size >= MAX_EXACT_REFERENCES) return [...references];
      }
    }
  }
  return [...references];
}

function auditNativeSummary(sessionTail: SessionTail, recentMessages: TranscriptMessage[]): NativeSummaryAudit {
  if (!sessionTail.available) {
    return {
      available: false,
      reasons: [sessionTail.reason || "session-tail-read-failed"],
    };
  }

  let latestCompaction: any;
  const lines = sessionTail.text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.type === "compaction") {
        latestCompaction = entry;
        break;
      }
    } catch {
      // Ignore malformed JSONL rows while searching for the newest complete compaction row.
    }
  }
  if (!latestCompaction) {
    return {
      available: false,
      reasons: ["compaction-entry-not-found-in-bounded-tail"],
    };
  }
  if (typeof latestCompaction.summary !== "string" || !latestCompaction.summary.trim()) {
    return {
      available: false,
      reasons: ["latest-compaction-summary-unavailable"],
    };
  }

  const summary = latestCompaction.summary;
  const reasons: string[] = [];
  if (summary.length > MAX_NATIVE_SUMMARY_CHARS) reasons.push("summary-too-long");
  if (!/^##(?:\s|$)/.test(summary.trimStart())) reasons.push("summary-not-structured");
  for (const section of NATIVE_SUMMARY_REQUIRED_SECTIONS) {
    const heading = `## ${section}`;
    if (!new RegExp(`(?:^|\\n)${escapeRegex(heading)}[ \\t]*(?:\\r?\\n|$)`).test(summary)) {
      reasons.push(`missing-required-section:${section}`);
    }
  }
  const latestUserRequest = firstMatchingRecentMessage(recentMessages, "real_user");
  if (latestUserRequest && !summary.includes(latestUserRequest)) {
    reasons.push("latest-user-request-missing");
  }
  const exactReferences = collectExactReferences(recentMessages);
  if (exactReferences.length && !exactReferences.some((reference) => summary.includes(reference))) {
    reasons.push("exact-reference-missing");
  }
  return {
    available: true,
    ok: reasons.length === 0,
    reasons,
    summaryLength: summary.length,
  };
}

function renderNativeSummaryAudit(audit: NativeSummaryAudit | undefined): string | undefined {
  if (!audit) return undefined;
  const lines = [
    "## Native Summary Audit",
    `- available: ${audit.available}`,
    ...(typeof audit.ok === "boolean" ? [`- ok: ${audit.ok}`] : []),
    ...(typeof audit.summaryLength === "number" ? [`- summaryLength: ${audit.summaryLength}`] : []),
    "- reasons:",
    ...(audit.reasons.length ? audit.reasons.map((reason) => `  - ${reason}`) : ["  - none"]),
  ];
  return clipUtf16Safe(lines.join("\n"), 1200, "\n…[native summary audit truncated]");
}

function detectCompletedSignals(recentMessages: TranscriptMessage[]): string[] {
  const signals: string[] = [];
  const patterns = [/已完成|完成|PASS|READY|commit|驗證|測試/i, /blocked|卡|error|失敗|風險/i];
  for (const item of [...recentMessages].reverse()) {
    if (item.provenance !== "assistant") continue;
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
  nativeSummaryAudit?: NativeSummaryAudit;
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
  const nativeSummaryAudit = renderNativeSummaryAudit(params.nativeSummaryAudit);
  const omittedRecent = "## Recent Conversation Extract\n…[omitted first to honor the 8000-char handoff budget]";
  let projectPointer = params.projectPointer?.trimEnd();

  if (projectPointer) {
    const withoutProject = joinHandoffSections([
      introduction,
      metadata,
      nativeSummaryAudit,
      workingState,
      omittedRecent,
    ]);
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

  const withoutRecent = joinHandoffSections([
    introduction,
    projectPointer,
    metadata,
    nativeSummaryAudit,
    workingState,
  ]);
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
  const rendered = joinHandoffSections([
    introduction,
    projectPointer,
    metadata,
    nativeSummaryAudit,
    workingState,
    recentExtract,
  ]);
  if (rendered.length <= MAX_HANDOFF_BODY_CHARS) return rendered;

  // Defensive structure-aware fallback: preserve metadata and deterministic state,
  // rather than slicing from either end and discarding the handoff structure.
  return clipUtf16Safe(
    joinHandoffSections([introduction, metadata, nativeSummaryAudit, workingState]),
    MAX_HANDOFF_BODY_CHARS,
    "\n…[lower-priority handoff sections omitted]",
  );
}

function noFollowReadFlags(): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  return fsConstants.O_RDONLY | noFollow;
}

function assertSafeRegularFileStat(stat: any, maxBytes: number) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile()) {
    throw Object.assign(new Error("file is not regular"), { code: "EINVAL" });
  }
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw Object.assign(new Error("file owner mismatch"), { code: "EACCES" });
  }
  if ((stat.mode & 0o022) !== 0) {
    throw Object.assign(new Error("file is group/world writable"), { code: "EACCES" });
  }
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
    throw Object.assign(new Error("file exceeds byte limit"), { code: "EFBIG" });
  }
}

function assertFileIdentity(stat: any, expectedIdentity?: FileIdentity) {
  if (expectedIdentity
      && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) {
    throw Object.assign(new Error("file identity changed"), { code: "ESTALE" });
  }
}

function assertStableFileSnapshot(before: any, after: any, maxBytes: number) {
  assertSafeRegularFileStat(after, maxBytes);
  if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
    throw Object.assign(new Error("file changed during read"), { code: "ESTALE" });
  }
}

async function transcriptByteSize(
  sessionFile: string | undefined,
  expectedIdentity?: FileIdentity,
): Promise<number | undefined> {
  if (!sessionFile) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(sessionFile, noFollowReadFlags());
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, Number.MAX_SAFE_INTEGER);
    assertFileIdentity(stat, expectedIdentity);
    return stat.size;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type SessionsStoreCacheEntry = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  value: any;
};
const sessionsStoreCache = new Map<string, SessionsStoreCacheEntry>();
const MAX_SESSIONS_STORE_CACHE_ENTRIES = 16;

async function readCachedSessionsStore(filePath: string): Promise<any> {
  const handle = await fs.open(filePath, noFollowReadFlags());
  try {
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, MAX_SESSIONS_STORE_BYTES);
    const cached = sessionsStoreCache.get(filePath);
    if (cached
      && cached.dev === stat.dev
      && cached.ino === stat.ino
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs
      && cached.ctimeMs === stat.ctimeMs) {
      return cached.value;
    }

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead <= 0) {
        throw Object.assign(new Error("short sessions-store read"), { code: "EIO" });
      }
      offset += bytesRead;
    }
    const postReadStat = await handle.stat();
    assertStableFileSnapshot(stat, postReadStat, MAX_SESSIONS_STORE_BYTES);
    let parsed: any;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid sessions store"), { code: "EINVAL" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("invalid sessions store shape"), { code: "EINVAL" });
    }
    sessionsStoreCache.delete(filePath);
    sessionsStoreCache.set(filePath, {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      value: parsed,
    });
    while (sessionsStoreCache.size > MAX_SESSIONS_STORE_CACHE_ENTRIES) {
      const oldest = sessionsStoreCache.keys().next().value;
      if (typeof oldest !== "string") break;
      sessionsStoreCache.delete(oldest);
    }
    return parsed;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<{ text: string; mtimeMs: number; size: number }> {
  const handle = await fs.open(filePath, noFollowReadFlags());
  try {
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, maxBytes);
    if (stat.size === 0) return { text: "", mtimeMs: stat.mtimeMs, size: 0 };
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) {
      throw Object.assign(new Error("short regular-file read"), { code: "EIO" });
    }
    const postReadStat = await handle.stat();
    assertStableFileSnapshot(stat, postReadStat, maxBytes);
    return {
      text: buffer.toString("utf8"),
      mtimeMs: postReadStat.mtimeMs,
      size: postReadStat.size,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function boundedStateNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : undefined;
}

function boundedStateTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
    ? value
    : undefined;
}

function sanitizeEarlyState(input: unknown): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source: any = input;
  const state: any = {};
  for (const key of [
    "lastEarlyAtMs",
    "lastEarlyTokens",
    "lastEarlyContextTokens",
    "lastTranscriptBytes",
  ]) {
    const value = boundedStateNumber(source[key]);
    if (value !== undefined) state[key] = value;
  }
  const lastRatio = boundedStateNumber(source.lastRatio, 100);
  if (lastRatio !== undefined) state.lastRatio = lastRatio;
  const lastEarlyAt = boundedStateTimestamp(source.lastEarlyAt);
  if (lastEarlyAt) state.lastEarlyAt = lastEarlyAt;
  if (source.lastBucket === "high" || source.lastBucket === "soft") state.lastBucket = source.lastBucket;
  if (source.lastObservedBucket === "high" || source.lastObservedBucket === "soft") {
    state.lastObservedBucket = source.lastObservedBucket;
  }

  if ("injection" in source) {
    const injection = source.injection;
    if (!injection || typeof injection !== "object" || Array.isArray(injection)) {
      throw new Error("invalid injection state shape");
    }
    const generationId = validatedHandoffGenerationId(injection.generationId);
    const attempts = boundedStateNumber(injection.attempts, 1);
    const expiresAtMs = boundedStateNumber(injection.expiresAtMs);
    const status = injection.status === "expired" || injection.status === "injected-once-unconfirmed"
      ? injection.status
      : undefined;
    if (!generationId
        || !Number.isInteger(attempts)
        || expiresAtMs === undefined
        || !status
        || (status === "injected-once-unconfirmed" && attempts !== 1)
        || (status === "expired" && attempts !== 0)
        || ("consumed" in injection && injection.consumed !== false)
        || ("mode" in injection && injection.mode !== HANDOFF_INJECTION_MODE)) {
      throw new Error("invalid injection state shape");
    }
    const cleanInjection: any = {
      generationId,
      attempts,
      consumed: false,
      status,
      mode: HANDOFF_INJECTION_MODE,
      expiresAtMs,
    };
    for (const [key, validator] of [
      ["injectedAtMs", boundedStateNumber],
      ["injectedAt", boundedStateTimestamp],
      ["expiresAt", boundedStateTimestamp],
    ] as const) {
      if (!(key in injection)) continue;
      const value = validator(injection[key] as never);
      if (value === undefined) throw new Error("invalid injection state shape");
      cleanInjection[key] = value;
    }
    state.injection = cleanInjection;
  }
  return state;
}

async function pruneCorruptStateArtifacts(statePath: string, now = Date.now()) {
  const directory = path.dirname(statePath);
  const prefix = `${path.basename(statePath)}.corrupt-`;
  const suffixPattern = /^\d{13}-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => (
      name.startsWith(prefix) && suffixPattern.test(name.slice(prefix.length))
    ));
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const retained: Array<{ filePath: string; mtimeMs: number }> = [];
  let changed = false;
  for (const name of names) {
    const filePath = path.join(directory, name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isDirectory()) continue;
      if (!stat.isFile()
          || stat.isSymbolicLink()
          || stat.size > MAX_STATE_FILE_BYTES
          || now - stat.mtimeMs > STATE_CORRUPT_RETENTION_MS) {
        await fs.unlink(filePath);
        changed = true;
      } else {
        retained.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  retained.sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
  for (const entry of retained.slice(STATE_CORRUPT_RETENTION_COUNT)) {
    await fs.unlink(entry.filePath).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
    changed = true;
  }
  if (changed) await syncDirectory(directory);
}

async function preserveMalformedState(
  statePath: string,
  reason: string,
  boundedRaw?: string,
): Promise<void> {
  const corruptPath = `${statePath}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(statePath, corruptPath);
    await syncDirectory(path.dirname(statePath));
    try {
      const stat = await fs.lstat(corruptPath);
      await writeFileAtomic(corruptPath, `${JSON.stringify({
        schemaVersion: 1,
        quarantined: true,
        reason,
        originalSize: stat.isFile() ? stat.size : undefined,
        originalSha256: boundedRaw === undefined
          ? undefined
          : createHash("sha256").update(boundedRaw, "utf8").digest("hex"),
      }, null, 2)}\n`);
    } catch (error) {
      await fs.unlink(corruptPath).catch(() => undefined);
      await syncDirectory(path.dirname(statePath)).catch(() => undefined);
      throw error;
    }
    await pruneCorruptStateArtifacts(statePath);
    logWarn(`preserved malformed state metadata at ${path.basename(corruptPath)} (${reason})`);
    return;
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function invalidLifecycleStateError(): Error & { code: string } {
  return Object.assign(new Error("invalid lifecycle state"), { code: "EINVALIDSTATE" });
}

async function readEarlyState(handoffDir: string, sessionKeyOrId: string): Promise<any> {
  const statePath = sessionScopedStatePath(handoffDir, sessionKeyOrId);
  let raw: string;
  try {
    raw = (await readBoundedRegularFile(statePath, MAX_STATE_FILE_BYTES)).text;
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    if (error?.code === "EFBIG") {
      await preserveMalformedState(statePath, "state exceeds byte limit");
      throw invalidLifecycleStateError();
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("state root is not an object");
    }
    return sanitizeEarlyState(parsed);
  } catch (error: any) {
    const reason = error instanceof SyntaxError ? "invalid JSON" : "invalid state shape";
    await preserveMalformedState(statePath, reason, raw);
    throw invalidLifecycleStateError();
  }
}

async function writeEarlyState(handoffDir: string, sessionKeyOrId: string, state: any) {
  const statePath = path.join(handoffDir, `session_${sessionStorageSlug(sessionKeyOrId)}.state.json`);
  await pruneCorruptStateArtifacts(statePath);
  await writeFileAtomic(statePath, `${JSON.stringify(sanitizeEarlyState(state), null, 2)}\n`);
}

function boundedIndexString(value: unknown, maxLength = 4096): string | undefined {
  return typeof value === "string"
      && value.length > 0
      && value.length <= maxLength
      && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function allowedNativeSummaryAuditReason(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (new Set([
    "session-file-unavailable",
    "session-tail-read-failed",
    "compaction-entry-not-found-in-bounded-tail",
    "latest-compaction-summary-unavailable",
    "summary-too-long",
    "summary-not-structured",
    "latest-user-request-missing",
    "exact-reference-missing",
  ]).has(value)) return true;
  const missingSection = value.match(/^missing-required-section:(.+)$/)?.[1];
  return Boolean(missingSection && NATIVE_SUMMARY_REQUIRED_SECTIONS.includes(missingSection as any));
}

function sanitizeIndexAudit(value: unknown): NativeSummaryAudit | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source: any = value;
  if (typeof source.available !== "boolean" || !Array.isArray(source.reasons)) return undefined;
  if (source.reasons.length > 16 || !source.reasons.every(allowedNativeSummaryAuditReason)) return undefined;
  const audit: NativeSummaryAudit = {
    available: source.available,
    reasons: [...source.reasons],
  };
  if (typeof source.ok === "boolean") audit.ok = source.ok;
  if (Number.isSafeInteger(source.summaryLength)
      && source.summaryLength >= 0
      && source.summaryLength <= MAX_SESSION_TAIL_BYTES) {
    audit.summaryLength = source.summaryLength;
  }
  return audit;
}

function sanitizeIndexSessionEntry(value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("index session entry is not an object");
  }
  const source: any = value;
  const entry: any = {};
  if (source.phase === "before" || source.phase === "after" || source.phase === "early") entry.phase = source.phase;
  const project = safeProjectName(source.project);
  if (project) entry.project = project;
  const sessionId = safePathComponent(source.sessionId, 180);
  if (sessionId) entry.sessionId = sessionId;
  for (const key of ["sessionFile", "currentPath", "archivePath", "projectRecoveryPath"] as const) {
    const bounded = boundedIndexString(source[key]);
    if (bounded) entry[key] = bounded;
  }
  for (const key of ["totalTokens", "contextTokens"] as const) {
    const bounded = safeRuntimeNumber(source[key]);
    if (bounded !== undefined) entry[key] = bounded;
  }
  for (const key of ["updatedAt", "lastProjectInjectedAt"] as const) {
    const timestamp = boundedStateTimestamp(source[key]);
    if (timestamp) entry[key] = timestamp;
  }
  const audit = sanitizeIndexAudit(source.nativeSummaryAudit);
  if (audit) entry.nativeSummaryAudit = audit;
  return entry;
}

function sanitizeIndexRoot(value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("index root is not an object");
  }
  const source: any = value;
  if ("sessions" in source
      && (!source.sessions || typeof source.sessions !== "object" || Array.isArray(source.sessions))) {
    throw new Error("index sessions is not an object");
  }
  const sessions = Object.create(null);
  for (const [sessionKey, entry] of Object.entries(source.sessions || {})) {
    if (!sessionKey
        || sessionKey.length > 512
        || /[\u0000-\u001f\u007f]/.test(sessionKey)) {
      throw new Error("invalid index session key");
    }
    sessions[sessionKey] = sanitizeIndexSessionEntry(entry);
  }
  return { sessions };
}

const indexUpdateQueues = new Map<string, Promise<void>>();

async function readIndexForUpdate(indexPath: string): Promise<any> {
  let raw: string;
  try {
    raw = (await readBoundedRegularFile(indexPath, MAX_INDEX_FILE_BYTES)).text;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { sessions: {} };
    throw error;
  }
  try {
    return sanitizeIndexRoot(JSON.parse(raw));
  } catch (error: any) {
    const corruptPath = `${indexPath}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
    try {
      await fs.rename(indexPath, corruptPath);
      await syncDirectory(path.dirname(indexPath));
      const reason = error instanceof SyntaxError ? "invalid JSON" : "invalid index shape";
      logWarn(`preserved malformed index at ${path.basename(corruptPath)} (${reason})`);
      return { sessions: {} };
    } catch (renameError: any) {
      if (renameError?.code === "ENOENT") return { sessions: {} };
      throw renameError;
    }
  }
}

async function updateIndexUnlocked(handoffDir: string, sessionKeyOrId: string, payload: any) {
  const indexPath = path.join(handoffDir, "index.json");
  const index = await readIndexForUpdate(indexPath);
  index.sessions = Object.assign(Object.create(null), index.sessions || {});
  index.sessions[sessionKeyOrId] = {
    ...(index.sessions[sessionKeyOrId] || {}),
    ...payload,
    updatedAt: localTimestamp(),
  };
  await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function withIndexUpdateQueue(handoffDir: string, task: () => Promise<void>) {
  const indexPath = path.join(handoffDir, "index.json");
  const lockPath = path.join(handoffDir, ".compact-handoff.index.lock");
  const previous = indexUpdateQueues.get(indexPath) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => withFilesystemLock(lockPath, task));
  indexUpdateQueues.set(indexPath, operation);
  try {
    await operation;
  } finally {
    if (indexUpdateQueues.get(indexPath) === operation) indexUpdateQueues.delete(indexPath);
  }
}

async function updateIndex(handoffDir: string, sessionKeyOrId: string, payload: any) {
  await withIndexUpdateQueue(handoffDir, () => updateIndexUnlocked(handoffDir, sessionKeyOrId, payload));
}

function pendingCurrentCommitPath(currentPath: string): string {
  return `${currentPath}.pending`;
}

function pendingCurrentCommitError(): Error & { code: string } {
  return Object.assign(new Error("pending current handoff commit"), { code: "EPENDING" });
}

async function createPendingCurrentCommit(markerPath: string, content: string): Promise<FileIdentity> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: FileIdentity | undefined;
  try {
    handle = await fs.open(
      markerPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = await handle.stat();
    assertSafeRegularFileStat(stat, 4096);
    identity = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path.dirname(markerPath));
    return identity;
  } catch (error: any) {
    await handle?.close().catch(() => undefined);
    if (identity) await removeFilesystemLockIfOwned(markerPath, identity).catch(() => undefined);
    if (error?.code === "EEXIST") throw pendingCurrentCommitError();
    throw error;
  }
}

async function clearPendingCurrentCommit(markerPath: string, identity: FileIdentity): Promise<void> {
  try {
    const removed = await removeFilesystemLockIfOwned(markerPath, identity);
    if (!removed) logWarn("pending current handoff marker ownership changed before clear");
  } catch (error: any) {
    if (error?.code !== "ENOENT") logWarn("failed to clear pending current handoff marker", error);
  }
}

async function commitCurrentAndIndex(
  handoffDir: string,
  sessionKeyOrId: string,
  currentPath: string,
  content: string,
  payload: any,
) {
  await withIndexUpdateQueue(handoffDir, async () => {
    const indexPath = path.join(handoffDir, "index.json");
    const index = await readIndexForUpdate(indexPath);
    index.sessions = Object.assign(Object.create(null), index.sessions || {});
    index.sessions[sessionKeyOrId] = {
      ...(index.sessions[sessionKeyOrId] || {}),
      ...payload,
      updatedAt: localTimestamp(),
    };

    let previousCurrent: string | undefined;
    let previousCurrentExists = false;
    try {
      previousCurrent = (await readBoundedRegularFile(
        currentPath,
        MAX_CURRENT_HANDOFF_FILE_BYTES,
      )).text;
      previousCurrentExists = true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    const markerPath = pendingCurrentCommitPath(currentPath);
    const markerIdentity = await createPendingCurrentCommit(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      current: path.basename(currentPath),
      createdAt: localTimestamp(),
    })}\n`);
    let currentReplaced = false;
    let indexCommitted = false;
    let rollbackCompleted = false;
    try {
      await writeFileAtomic(currentPath, content);
      currentReplaced = true;
      try {
        await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
        indexCommitted = true;
      } catch (error: any) {
        try {
          if (previousCurrentExists) {
            await writeFileAtomic(currentPath, previousCurrent || "");
          } else {
            await fs.unlink(currentPath).catch((unlinkError: any) => {
              if (unlinkError?.code !== "ENOENT") throw unlinkError;
            });
            await syncDirectory(path.dirname(currentPath));
          }
          rollbackCompleted = true;
        } catch (rollbackError) {
          logWarn("failed to restore current handoff after index commit failure", rollbackError);
          (error as any).currentRollbackFailed = true;
        }
        throw error;
      }
    } finally {
      if (!currentReplaced || indexCommitted || rollbackCompleted) {
        await clearPendingCurrentCommit(markerPath, markerIdentity);
      }
    }
  });
}

async function pruneArchives(
  handoffDir: string,
  sessionSlug: string,
  phase: "before" | "after" | "early",
  now = Date.now(),
  protectedArchivePath?: string,
): Promise<void> {
  const prefixPattern = /^\d{8}T\d{6}_(before|after|early)_(.+)\.md$/;
  const entries = await fs.readdir(handoffDir, { withFileTypes: true });
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(prefixPattern);
    if (!match || match[1] !== phase) continue;
    const scopedName = match[2];
    if (!archiveBelongsToSession(scopedName, sessionSlug)) continue;
    const archivePath = path.join(handoffDir, entry.name);
    try {
      const stat = await fs.stat(archivePath);
      candidates.push({ path: archivePath, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent cleanup may already have removed it.
    }
  }
  const protectedCandidate = protectedArchivePath
    ? candidates.find((candidate) => candidate.path === protectedArchivePath)
    : undefined;
  const unprotectedCandidates = candidates
    .filter((candidate) => candidate !== protectedCandidate)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  const unprotectedLimit = Math.max(0, ARCHIVE_RETENTION_PER_PHASE - (protectedCandidate ? 1 : 0));
  const removals = unprotectedCandidates.filter((candidate, index) => (
    now - candidate.mtimeMs > ARCHIVE_RETENTION_MS || index >= unprotectedLimit
  ));
  for (const candidate of removals) {
    await fs.unlink(candidate.path).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function writeHandoffUnlocked(event: any, phase: "before" | "after" | "early", resolvedEntry?: any) {
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  await fs.mkdir(handoffDir, { recursive: true });

  const sessionEntry = resolvedEntry || await resolveSessionEntry(event);
  const sessionKeyOrId = event.sessionKey || sessionEntry.sessionId || "unknown";
  const sessionTail = await readSessionTail(sessionEntry.sessionFile, sessionEntry.sessionFileIdentity);
  const recentMessages = parseRecentMessages(sessionTail.text);
  const nativeSummaryAudit = phase === "after"
    ? auditNativeSummary(sessionTail, recentMessages)
    : undefined;
  const projectPointer = await buildProjectRecoveryPointer(workspaceDir, sessionKeyOrId);
  const content = buildHandoff({
    phase,
    event,
    recentMessages,
    sessionEntry,
    projectPointer: projectPointer?.content,
    nativeSummaryAudit,
  });
  const sessionSlug = sessionStorageSlug(sessionKeyOrId);
  const stamp = localTimestamp().replace(/[-:]/g, "");
  const archiveName = `${stamp}_${phase}_${sessionSlug}${ARCHIVE_INSTANCE_SEPARATOR}${randomUUID()}.md`;
  const archivePath = path.join(handoffDir, archiveName);
  const scopedCurrentPath = sessionScopedCurrentPath(handoffDir, sessionKeyOrId);

  await writeFileAtomic(archivePath, content);
  const indexPayload: any = {
    phase,
    project: projectPointer?.project,
    sessionId: sessionEntry.sessionId,
    sessionFile: sessionEntry.sessionFile,
    currentPath: scopedCurrentPath,
    archivePath,
    totalTokens: sessionEntry.totalTokens,
    contextTokens: sessionEntry.contextTokens,
  };
  if (nativeSummaryAudit) indexPayload.nativeSummaryAudit = nativeSummaryAudit;
  try {
    if (scopedCurrentPath) {
      await commitCurrentAndIndex(handoffDir, sessionKeyOrId, scopedCurrentPath, content, indexPayload);
    } else {
      await updateIndex(handoffDir, sessionKeyOrId, indexPayload);
    }
  } catch (error: any) {
    if (!error?.currentRollbackFailed) {
      try {
        await fs.unlink(archivePath).catch((unlinkError: any) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        await syncDirectory(handoffDir);
      } catch (cleanupError) {
        logWarn("failed to remove uncommitted archive", cleanupError);
      }
    } else {
      logWarn("retained uncommitted archive after current rollback failure", error);
    }
    throw error;
  }
  await pruneArchives(handoffDir, sessionSlug, phase, Date.now(), archivePath);
}

const sessionOperationQueues = new Map<string, Promise<void>>();

function sessionOperationIdentity(event: any): string {
  const context = event.context || {};
  return event.sessionKey
    || context.sessionKey
    || context.sessionEntry?.sessionId
    || context.sessionId
    || "unknown";
}

function sessionOperationQueueKey(event: any): string {
  return `${workspaceDirFromEvent(event)}\u0000${sessionOperationIdentity(event)}`;
}

function sessionFilesystemLockPath(event: any): string {
  const handoffDir = path.join(
    workspaceDirFromEvent(event),
    "memory",
    "session_handoffs",
  );
  return path.join(
    handoffDir,
    `.compact-handoff.session-${sessionStorageSlug(sessionOperationIdentity(event))}.lock`,
  );
}

async function withSessionOperationQueue(
  event: any,
  operationBody: () => Promise<void>,
  useFilesystemLock = true,
) {
  const queueKey = sessionOperationQueueKey(event);
  const previous = sessionOperationQueues.get(queueKey) || Promise.resolve();
  const runOperation = useFilesystemLock
    ? () => withFilesystemLock(sessionFilesystemLockPath(event), operationBody)
    : operationBody;
  const operation = previous
    .catch(() => undefined)
    .then(runOperation);
  sessionOperationQueues.set(queueKey, operation);
  try {
    await operation;
  } finally {
    if (sessionOperationQueues.get(queueKey) === operation) sessionOperationQueues.delete(queueKey);
  }
}

async function writeHandoff(event: any, phase: "before" | "after" | "early", resolvedEntry?: any) {
  await withSessionOperationQueue(event, () => writeHandoffUnlocked(event, phase, resolvedEntry));
}

async function maybeWriteEarlyHandoffUnlocked(event: any) {
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  await fs.mkdir(handoffDir, { recursive: true });

  const sessionEntry = await resolveSessionEntry(event);
  const sessionKeyOrId = event.sessionKey || sessionEntry.sessionId || "unknown";
  if (sessionKeyOrId === "unknown") return;

  const totalTokens = typeof sessionEntry.totalTokens === "number" ? sessionEntry.totalTokens : undefined;
  const contextTokens = typeof sessionEntry.contextTokens === "number" ? sessionEntry.contextTokens : undefined;
  const ratio = totalTokens && contextTokens ? totalTokens / contextTokens : 0;
  const byteSize = await transcriptByteSize(sessionEntry.sessionFile, sessionEntry.sessionFileIdentity);
  const thresholdHit = ratio >= EARLY_TOKEN_RATIO || (byteSize ?? 0) >= EARLY_TRANSCRIPT_BYTES;
  if (!thresholdHit) return;

  const state = await readEarlyState(handoffDir, sessionKeyOrId);
  const now = Date.now();
  const lastAt = typeof state.lastEarlyAtMs === "number" ? state.lastEarlyAtMs : 0;
  const lastTokens = typeof state.lastEarlyTokens === "number" ? state.lastEarlyTokens : 0;
  const tokenDelta = totalTokens !== undefined ? totalTokens - lastTokens : 0;
  const clockRollback = lastAt > now;
  const elapsed = Math.max(0, now - lastAt);
  const bucket = ratio >= EARLY_FORCE_TOKEN_RATIO ? "high" : "soft";
  const lastRatio = typeof state.lastRatio === "number" ? state.lastRatio : 0;
  const lastBucket = state.lastBucket === "high" || state.lastBucket === "soft"
    ? state.lastBucket
    : lastRatio >= EARLY_FORCE_TOKEN_RATIO
    ? "high"
    : "soft";
  const lastObservedBucket = state.lastObservedBucket === "high" || state.lastObservedBucket === "soft"
    ? state.lastObservedBucket
    : lastBucket;
  const hardFloorElapsed = elapsed >= EARLY_HARD_MIN_INTERVAL_MS;
  const highToSoft = lastBucket === "high" && bucket === "soft";
  const directionalRefresh = lastObservedBucket === "soft" && bucket === "high" && hardFloorElapsed;
  const highToHighDeltaRefresh = lastBucket === "high"
    && bucket === "high"
    && tokenDelta >= EARLY_MIN_TOKEN_DELTA
    && hardFloorElapsed;
  const intervalRefresh = elapsed >= EARLY_REFRESH_INTERVAL_MS && !highToSoft;
  const shouldRefresh = !lastAt
    || (!highToSoft && (clockRollback || intervalRefresh || directionalRefresh || highToHighDeltaRefresh));
  if (!shouldRefresh) {
    if (bucket === "soft" && lastObservedBucket !== "soft") {
      await writeEarlyState(handoffDir, sessionKeyOrId, {
        ...state,
        lastObservedBucket: "soft",
      });
    }
    return;
  }

  event.context ||= {};
  event.context.triggerReason = clockRollback
    ? "persisted-clock-in-future"
    : ratio >= EARLY_TOKEN_RATIO
    ? `token-ratio-${ratio.toFixed(2)}`
    : `transcript-bytes-${byteSize}`;
  await writeHandoffUnlocked(event, "early", sessionEntry);
  await writeEarlyState(handoffDir, sessionKeyOrId, {
    ...state,
    lastEarlyAtMs: now,
    lastEarlyAt: localTimestamp(new Date(now)),
    lastEarlyTokens: totalTokens,
    lastEarlyContextTokens: contextTokens,
    lastTranscriptBytes: byteSize,
    lastRatio: ratio,
    lastBucket: bucket,
    lastObservedBucket: bucket,
  });
}

async function maybeWriteEarlyHandoff(event: any) {
  await withSessionOperationQueue(event, () => maybeWriteEarlyHandoffUnlocked(event));
}

async function injectBootstrapUnlocked(event: any) {
  const context = event.context || {};
  if (!Array.isArray(context.bootstrapFiles)) return;
  const workspaceDir = workspaceDirFromEvent(event);
  const handoffDir = path.join(workspaceDir, "memory", "session_handoffs");
  const sessionKey = event.sessionKey || context.sessionKey;
  const stateKey = sessionKey || "unknown";
  const currentPath = sessionScopedCurrentPath(handoffDir, sessionKey);
  let sessionBootstrapChars = 0;
  if (currentPath) {
    // Remove an exact preloaded session handoff before any lifecycle I/O. The
    // entry is re-added only after the generation-scoped state write commits.
    context.bootstrapFiles = context.bootstrapFiles.filter((file: any) => file?.path !== currentPath);
    try {
      await fs.mkdir(handoffDir, { recursive: true });
      await withFilesystemLock(sessionFilesystemLockPath(event), async () => {
      try {
        await fs.lstat(pendingCurrentCommitPath(currentPath));
        throw Object.assign(new Error("pending current handoff commit"), { code: "EPENDING" });
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      let content: string | undefined;
      let currentMtimeMs = 0;
      try {
        const snapshot = await readBoundedRegularFile(currentPath, MAX_CURRENT_HANDOFF_FILE_BYTES);
        content = snapshot.text;
        currentMtimeMs = snapshot.mtimeMs;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }

      if (content?.trim()) {
        const generationId = handoffGenerationId(content);
        const now = Date.now();
        const expiresAtMs = currentMtimeMs + HANDOFF_INJECTION_TTL_MS;
        const state = await readEarlyState(handoffDir, stateKey);
        const priorInjection = state.injection && typeof state.injection === "object"
          ? state.injection
          : undefined;
        const sameGenerationAlreadyInjected = priorInjection?.generationId === generationId
          && typeof priorInjection.attempts === "number"
          && priorInjection.attempts >= 1;
        const expired = now >= expiresAtMs;

        if (expired) {
          if (priorInjection?.generationId !== generationId || priorInjection?.status !== "expired") {
            await writeEarlyState(handoffDir, stateKey, {
              ...state,
              injection: {
                generationId,
                attempts: 0,
                consumed: false,
                status: "expired",
                mode: HANDOFF_INJECTION_MODE,
                expiresAtMs,
                expiresAt: localTimestamp(new Date(expiresAtMs)),
              },
            });
          }
        } else if (!sameGenerationAlreadyInjected) {
          const boundedContent = clipUtf16Safe(
            content,
            MAX_HANDOFF_BODY_CHARS,
            "\n…[legacy compact handoff truncated for bootstrap]",
          );
          await writeEarlyState(handoffDir, stateKey, {
            ...state,
            injection: {
              generationId,
              attempts: 1,
              consumed: false,
              status: "injected-once-unconfirmed",
              mode: HANDOFF_INJECTION_MODE,
              injectedAtMs: now,
              injectedAt: localTimestamp(new Date(now)),
              expiresAtMs,
              expiresAt: localTimestamp(new Date(expiresAtMs)),
            },
          });
          context.bootstrapFiles = [
            ...context.bootstrapFiles,
            {
              name: "MEMORY.md",
              path: currentPath,
              content: boundedContent,
              missing: false,
            },
          ];
          sessionBootstrapChars = boundedContent.length;
        }
      }
      });
    } catch (error) {
      // Session handoff lifecycle is fail-closed, but project recovery remains
      // an independent bootstrap source and must still be attempted below.
      logWarn("session handoff injection skipped", error);
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
  await updateIndex(handoffDir, stateKey, {
    project: projectPointer.project,
    lastProjectInjectedAt: localTimestamp(),
    projectRecoveryPath: projectPointer.virtualPath,
  });
}

async function injectBootstrap(event: any) {
  await withSessionOperationQueue(event, () => injectBootstrapUnlocked(event), false);
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
