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

record("required files exist", (await exists(handlerPath)) && (await exists(hookDocPath)) && (await exists(testPath)));

const pkg = JSON.parse(await read(packagePath));
record("package exposes hook", Array.isArray(pkg.openclaw?.hooks) && pkg.openclaw.hooks.includes("hooks/compact-handoff"));
record("package has post-run script", pkg.scripts?.["postrun:check"] === "node scripts/post_run_check.mjs");

const handler = await read(handlerPath);
record("session-scoped handoff path", /session_\$\{safeSlug\(sessionKeyOrId\)\}\.MEMORY\.md/.test(handler));
record("no global latest handoff fallback", !handler.includes("current_session_handoff.MEMORY.md"));
record("redaction still present", /redactSensitiveText/.test(handler) && /REDACTED/.test(handler));

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
