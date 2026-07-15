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

record("required files exist", (await exists(handlerPath)) && (await exists(hookDocPath)) && (await exists(testPath)));

const pkg = JSON.parse(await read(packagePath));
record("package exposes hook", Array.isArray(pkg.openclaw?.hooks) && pkg.openclaw.hooks.includes("hooks/compact-handoff"));
record("package has post-run script", pkg.scripts?.["postrun:check"] === "node scripts/post_run_check.mjs");
record("package ships runnable checks", Array.isArray(pkg.files)
  && pkg.files.includes("scripts/test_compact_handoff_hook.mjs")
  && pkg.files.includes("scripts/test_compact_handoff_resilience.mjs")
  && pkg.files.includes("scripts/post_run_check.mjs"));
record("package has resilience suite", pkg.scripts?.["test:resilience"] === "node scripts/test_compact_handoff_resilience.mjs");

const handler = await read(handlerPath);
const resilience = await read(resiliencePath);
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
record("session transaction and index I/O safety", /handoffWriteQueues/.test(handler)
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
  && /earlyWriteQueues/.test(handler)
  && /lastObservedBucket/.test(handler)
  && /highToSoft/.test(handler)
  && /highToHighDeltaRefresh/.test(handler)
  && /clockRollback/.test(handler)
  && resilience.includes("future persisted clock suppressed")
  && resilience.includes("10K token delta did not refresh after the five-minute hard floor")
  && resilience.includes("high-to-soft pressure change incorrectly triggered after the normal interval")
  && resilience.includes("soft-to-soft 10K token delta incorrectly triggered")
  && resilience.includes("observed soft-to-high recovery did not refresh"));
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
