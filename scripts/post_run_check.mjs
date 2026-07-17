#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const checks = [];

async function exists(rel) {
  try {
    await fs.access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

const handlerPath = "hooks/compact-handoff/handler.ts";
const hookDocPath = "hooks/compact-handoff/HOOK.md";
const packagePath = "package.json";
const testPath = "scripts/test_compact_handoff_hook.mjs";
const resiliencePath = "scripts/test_compact_handoff_resilience.mjs";
const p1cPath = "scripts/test_compact_handoff_p1c.mjs";
const authorityHarnessPath = "scripts/test_session_authority.mjs";

record("required files exist", (await exists(handlerPath))
  && (await exists(hookDocPath))
  && (await exists(testPath))
  && (await exists(resiliencePath))
  && (await exists(p1cPath))
  && (await exists(authorityHarnessPath)));

const pkg = JSON.parse(await read(packagePath));
record("package exposes hook", Array.isArray(pkg.openclaw?.hooks) && pkg.openclaw.hooks.includes("hooks/compact-handoff"));
record("package has post-run script", pkg.scripts?.["postrun:check"] === "node scripts/post_run_check.mjs");
record("package ships runnable checks", Array.isArray(pkg.files)
  && pkg.files.includes("scripts/test_compact_handoff_hook.mjs")
  && pkg.files.includes("scripts/test_compact_handoff_resilience.mjs")
  && pkg.files.includes("scripts/test_compact_handoff_p1c.mjs")
  && pkg.files.includes("scripts/test_session_authority.mjs")
  && pkg.files.includes("scripts/post_run_check.mjs"));
record("package has resilience suite", pkg.scripts?.["test:resilience"] === "node scripts/test_compact_handoff_resilience.mjs");
record("package has P1-C suite", pkg.scripts?.["test:p1c"] === "node scripts/test_compact_handoff_p1c.mjs"
  && pkg.scripts?.test?.includes("npm run test:p1c"));

const handler = await read(handlerPath);
const resilience = await read(resiliencePath);
const coreTest = await read(testPath);
const p1c = await read(p1cPath);
record("session-scoped handoff path", /session_\$\{sessionStorageSlug\(sessionKeyOrId\)\}\.MEMORY\.md/.test(handler));
record("collision-resistant session storage", /function sessionStorageSlug/.test(handler)
  && /createHash\("sha256"\)/.test(handler)
  && resilience.includes("lossy slug collision crossed archive ownership"));
record("no global latest handoff fallback", !handler.includes("current_session_handoff.MEMORY.md"));
record("redaction still present", /redactSensitiveText/.test(handler) && /REDACTED/.test(handler));
record("warnings omit raw error messages", !handler.includes("error.message") && !handler.includes("String(error)"));
record("v2 hard budgets present", /MAX_HANDOFF_BODY_CHARS\s*=\s*8000/.test(handler)
  && /MAX_PROJECT_POINTER_CHARS\s*=\s*2000/.test(handler)
  && /MAX_TOTAL_BOOTSTRAP_CHARS\s*=\s*10000/.test(handler));
record("atomic write path present", /writeFileAtomic/.test(handler) && /handle\.sync\(\)/.test(handler) && /fs\.rename\(tempPath, filePath\)/.test(handler));
record("index updates serialized", /indexUpdateQueues/.test(handler)
  && /withIndexUpdateQueue/.test(handler)
  && /readIndexForUpdate/.test(handler)
  && /\.corrupt-/.test(handler));
record("session transaction and index I/O safety", /sessionOperationQueues/.test(handler)
  && /withSessionOperationQueue/.test(handler)
  && /commitCurrentAndIndex/.test(handler)
  && /previousCurrent/.test(handler)
  && /readIndexForUpdate/.test(handler)
  && /invalid index shape/.test(handler)
  && /failed to remove uncommitted archive/.test(handler)
  && resilience.includes("same-session current/index/archive generations diverged")
  && resilience.includes("failed index rename did not restore the prior current generation")
  && resilience.includes("non-corruption index read failure left current handoff inconsistent"));
record("archive retention present", /ARCHIVE_RETENTION_PER_PHASE\s*=\s*5/.test(handler)
  && /ARCHIVE_RETENTION_MS\s*=\s*30\s*\*/.test(handler)
  && /ARCHIVE_INSTANCE_SEPARATOR\s*=\s*"@"/.test(handler)
  && /ARCHIVE_INSTANCE_SUFFIX_PATTERN/.test(handler)
  && /archiveBelongsToSession/.test(handler)
  && /protectedArchivePath/.test(handler)
  && /pruneArchives/.test(handler)
  && resilience.includes("reserved archive separator leaked into session storage ID")
  && resilience.includes("lossless storage ID crossed lossy archive ownership")
  && resilience.includes("failed current/index transaction left an orphan archive")
  && resilience.includes("retention deleted the archive referenced by the committed index"));
record("early refresh hard floor present", /EARLY_HARD_MIN_INTERVAL_MS\s*=\s*5\s*\*/.test(handler)
  && /EARLY_REFRESH_INTERVAL_MS\s*=\s*20\s*\*/.test(handler)
  && /sessionOperationQueues/.test(handler)
  && /lastObservedBucket/.test(handler)
  && /highToSoft/.test(handler)
  && /highToHighDeltaRefresh/.test(handler)
  && /clockRollback/.test(handler)
  && resilience.includes("future persisted clock suppressed")
  && resilience.includes("10K token delta did not refresh after the five-minute hard floor")
  && resilience.includes("high-to-soft pressure change incorrectly triggered after the normal interval")
  && resilience.includes("soft-to-soft 10K token delta incorrectly triggered")
  && resilience.includes("observed soft-to-high recovery did not refresh"));
record("degraded one-shot injection lifecycle present", /HANDOFF_INJECTION_TTL_MS\s*=\s*24\s*\*/.test(handler)
  && /single-bootstrap-no-delivery-correlation/.test(handler)
  && /injected-once-unconfirmed/.test(handler)
  && /withSessionOperationQueue/.test(handler)
  && /sameGenerationAlreadyInjected/.test(handler)
  && /status:\s*"expired"/.test(handler)
  && coreTest.includes("concurrent bootstraps injected one generation")
  && coreTest.includes("lifecycle state read I/O failure left a preloaded untracked session handoff")
  && coreTest.includes("lifecycle state read I/O failure suppressed independent project recovery")
  && coreTest.includes("current handoff read I/O failure left a preloaded untracked session handoff")
  && coreTest.includes("current handoff read I/O failure suppressed independent project recovery")
  && coreTest.includes("unsafe-mode current handoff remained injectable or preloaded")
  && coreTest.includes("unsafe-mode lifecycle state allowed or retained a session handoff")
  && coreTest.includes("lifecycle mkdir failure left a preloaded untracked session handoff")
  && coreTest.includes("lifecycle mkdir failure suppressed independent project recovery")
  && coreTest.includes("lifecycle state write failure left a preloaded untracked session handoff")
  && coreTest.includes("lifecycle state write failure suppressed independent project recovery")
  && coreTest.includes("early-handoff state refresh erased or mutated injection lifecycle state"));
record("bounded state and authoritative transcript safety", /MAX_STATE_FILE_BYTES\s*=\s*32\s*\*\s*1024/.test(handler)
  && /MAX_SESSIONS_STORE_BYTES/.test(handler)
  && /readCachedSessionsStore/.test(handler)
  && /MAX_SESSIONS_STORE_CACHE_ENTRIES\s*=\s*16/.test(handler)
  && /O_NOFOLLOW/.test(handler)
  && /trustedConventionalTranscript/.test(handler)
  && /sanitizeEarlyState/.test(handler)
  && /invalidLifecycleStateError/.test(handler)
  && /validatedHandoffGenerationId/.test(handler)
  && /pruneCorruptStateArtifacts/.test(handler)
  && coreTest.includes("same-session compact write bypassed the bootstrap lifecycle queue")
  && coreTest.includes("bootstrap followed a symlinked current handoff")
  && coreTest.includes("bootstrap followed a symlinked lifecycle state")
  && coreTest.includes("lifecycle state did not use one bounded handle read")
  && coreTest.includes("lifecycle state persisted a secret through the known generationId field")
  && coreTest.includes("lifecycle corrupt-state retention exceeded 3")
  && coreTest.includes("malformed lifecycle state injected in the same attempt that quarantined state")
  && coreTest.includes("invalid lifecycle state shape injected in the same attempt that quarantined state")
  && coreTest.includes("oversized lifecycle state injected in the same attempt that quarantined state")
  && coreTest.includes("routine successful state commit did not enforce corrupt retention count")
  && coreTest.includes("inconsistent injected lifecycle status/attempt count did not fail closed into quarantine")
  && coreTest.includes("corrupt-state retention deleted a prefix-neighbor primary lifecycle state")
  && resilience.includes("failed current handoff write changed the prior live current content")
  && p1c.includes("event-provided sessionFile crossed session ownership boundary")
  && p1c.includes("sessions store was not opened with O_NOFOLLOW")
  && p1c.includes("oversized sessions store was read before the 8 MiB bound rejected it")
  && p1c.includes("safe topic identifier did not resolve its conventional transcript")
  && p1c.includes("identifier selected the victim transcript")
  && p1c.includes("non-exact alias path was accepted as authoritative transcript binding")
  && p1c.includes("authoritative transcript validation was not bound to the opened inode")
  && p1c.includes("transcript inode swap did not fail the opened handle with ESTALE")
  && p1c.includes("truncated trailing JSONL row displaced the newest complete compaction")
  && p1c.includes("earlier real-user text incorrectly satisfied the latest-user requirement")
  && p1c.includes("synthetic/tool/system messages displaced the latest real user")
  && p1c.includes("sessions-store cache did not evict beyond 16 entries")
  && /cachedStoreStatCount/.test(p1c)
  && /assertFileIdentity/.test(handler)
  && p1c.includes("unchanged authoritative sessions store bypassed identity cache")
  && p1c.includes("replaced authoritative sessions store reused a stale identity cache entry")
  && p1c.includes("authoritative transcript resolver followed a symlinked conventional path")
  && p1c.includes("invalid authoritative sessionId escaped the agent sessions directory"));
record("bounded native summary audit present", /MAX_SESSION_TAIL_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024/.test(handler)
  && /MAX_NATIVE_SUMMARY_CHARS\s*=\s*16000/.test(handler)
  && /NATIVE_SUMMARY_REQUIRED_SECTIONS/.test(handler)
  && /readSessionTail/.test(handler)
  && /auditNativeSummary/.test(handler)
  && /nativeSummaryAudit/.test(handler)
  && p1c.includes("post-compaction path attempted")
  && p1c.includes("bounded/shared transcript tail invariant failed")
  && p1c.includes("early index update erased or changed the latest native summary audit")
  && p1c.includes("nativeSummaryAudit persisted a non-allowlisted key")
  && p1c.includes("nativeSummaryAudit persisted a non-allowlisted reason")
  && p1c.includes("index persisted secret-bearing native summary body content")
  && p1c.includes("newest unusable compaction row fell back")
  && p1c.includes("native audit persisted secret-bearing summary content"));
record("expanded secret scrubber present", /REDACTED_PRIVATE_KEY/.test(handler)
  && /redactCookieHeaders/.test(handler)
  && /REDACTED_GITHUB_TOKEN/.test(handler)
  && /REDACTED_SLACK_TOKEN/.test(handler)
  && /Set-Cookie/.test(handler)
  && /signature/.test(handler)
  && resilience.includes("P1B_JSON_API_KEY_SECRET")
  && resilience.includes("P1B_INLINE_COOKIE_SECRET")
  && resilience.includes("P1B_QUOTED_COOKIE_SECRET")
  && resilience.includes("P1B_QUOTED_SET_COOKIE_SECRET")
  && resilience.includes("P1B_UNTERMINATED_PRIVATE_KEY"));
record("final quality and cross-instance closure", /MAX_INDEX_FILE_BYTES\s*=\s*512\s*\*\s*1024/.test(handler)
  && /FILE_LOCK_WAIT_MS/.test(handler)
  && /withFilesystemLock/.test(handler)
  && /lockOwnerAppearsAlive/.test(handler)
  && /createRecoveryClaim/.test(handler)
  && /recoveryMarkerBlocks/.test(handler)
  && /pendingCurrentCommitPath/.test(handler)
  && /createPendingCurrentCommit/.test(handler)
  && /assertStableFileSnapshot/.test(handler)
  && /redactAuthorizationHeaders/.test(handler)
  && /preserved malformed state metadata/.test(handler)
  && coreTest.includes("parseable invalid injection state was silently treated as pristine lifecycle state")
  && coreTest.includes("invalid known lifecycle field did not fail closed into quarantine metadata")
  && coreTest.includes("corrupt-artifact directory blocked all subsequent lifecycle state writes")
  && resilience.includes("independent handler instances lost shared index updates")
  && resilience.includes("independent handler instances duplicated one-shot bootstrap injection")
  && resilience.includes("separate Node processes duplicated one-shot bootstrap injection")
  && resilience.includes("dead-owner stale filesystem lock did not recover safely")
  && resilience.includes("concurrent stale recovery violated filesystem-lock exclusion")
  && resilience.includes("interrupted stale recovery did not preserve its marker and fail closed")
  && resilience.includes("oversized index was read or partially committed before the 512 KiB bound rejected it")
  && resilience.includes("retain evidence and block bootstrap with a pending marker")
  && resilience.includes("pre-existing pending marker was overwritten or cleared by a later transaction")
  && p1c.includes("non-Bearer Authorization credential survived persisted handoff redaction")
  && p1c.includes("quoted or assigned Authorization credential survived persisted handoff redaction")
  && p1c.includes("continued or shell-wrapped Authorization credential survived persisted handoff redaction")
  && p1c.includes("quoted or assigned Cookie credential survived persisted handoff redaction")
  && p1c.includes("shell-adjacent or unquoted-continued header credential survived persisted handoff redaction")
  && p1c.includes("quoted or shell-adjacent folded header credential survived persisted handoff redaction")
  && p1c.includes("structured JSON delimiter or safe field was over-redacted")
  && p1c.includes("dynamic shell header command credential survived persisted handoff redaction")
  && p1c.includes("enclosing-quote dynamic shell credential survived persisted handoff redaction")
  && p1c.includes("enclosing-quote dynamic shell fixture lost nested quote or expansion syntax")
  && p1c.includes("adjacent quoted dynamic shell credential survived persisted handoff redaction")
  && p1c.includes("adjacent quoted dynamic shell fixture lost quote adjacency or nested argument")
  && p1c.includes("line-spliced dynamic shell credential survived persisted handoff redaction")
  && p1c.includes("spliced dynamic shell fixture lost continuation, expansion, or nested quote")
  && p1c.includes("line-spliced credential header key survived persisted handoff redaction")
  && p1c.includes("spliced credential header-key fixture lost continuation or decoded assignment")
  && p1c.includes("line-splice quote-parity credential survived persisted handoff redaction")
  && p1c.includes("splice quote-parity fixture lost residual escape or credential membership")
  && p1c.includes("shell-splice assignment scan retained multiplicative offset search")
  && p1c.includes("shell-splice linear stress fixture left the bounded near-2-MiB range")
  && p1c.includes("shell-splice assignment stress was non-linear or failed closed incorrectly")
  && p1c.includes("pre-header shell-splice linear stress fixture left the bounded near-2-MiB range")
  && p1c.includes("pre-header shell-splice functional credential was not redacted")
  && p1c.includes("pre-header stress did not force every splice strictly before every assignment")
  && p1c.includes("pre-header shell-splice stress was non-linear or failed redaction")
  && p1c.includes("quoted-key shell intersection credential survived persisted handoff redaction")
  && p1c.includes("pretty or array structured safe field was over-redacted")
  && p1c.includes("structural JSON header or embedded shell credential survived persisted handoff redaction")
  && p1c.includes("structural JSON safe field was over-redacted")
  && p1c.includes("structural JSON depth-bound credential survived persisted handoff redaction")
  && p1c.includes("structural JSON depth boundary did not preserve or fail safe as documented")
  && p1c.includes("topLevelJsonStringCredential")
  && p1c.includes("repeatedJsonStringCredential")
  && p1c.includes("JSON-looking primitive safe string was normalized during structural redaction")
  && p1c.includes("depth64Credential")
  && handler.includes("shellContinuationBefore")
  && handler.includes("hasShellAdjacency")
  && handler.includes("headerContinuesAfterNewline")
  && handler.includes("continuedHeaderValueEnd")
  && handler.includes("credentialHeaderValueSpan")
  && handler.includes("startsDynamicShellExpansion")
  && handler.includes("shellLineSplicesEnd")
  && handler.includes("hasShellSplicedCredentialAssignment")
  && handler.includes("lastSpliceOffset")
  && handler.includes("parseJsonValue")
  && handler.includes("sanitizeStructuredJsonValue")
  && handler.includes("redactStructuredHeaderData")
  && handler.includes("CREDENTIAL_HEADER_KEY")
  && p1c.includes("non-after index mutation changed over-limit summary audit length")
  && p1c.includes("symlinked authoritative ancestor redirected the trusted sessions hierarchy")
  && p1c.includes("sessions store mutation during read was cached as authoritative")
  && p1c.includes("untrusted tool output was promoted into deterministic completion state")
  && p1c.includes("complete compaction aligned to the tail boundary was discarded"));

const test = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8" });
record("npm test passes", test.status === 0, test.status === 0 ? "" : (test.stderr || test.stdout).slice(-1200));

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failed.length) {
  console.error(`post-run check failed: ${failed.length} issue(s)`);
  process.exit(1);
}

console.log("post-run check passed");
