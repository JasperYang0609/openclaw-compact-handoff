# Installation and Operations Guide

This guide is for human operators and AI assistants installing **OpenClaw Compact Handoff v0.2.0**.

## Prerequisites

Before changing anything, verify that OpenClaw already works:

```bash
openclaw --version
node --version
openclaw gateway status
openclaw hooks list
```

Requirements:

- a working OpenClaw installation;
- Node.js 22 or a newer version supported by that OpenClaw release;
- permission to install a hook pack and restart the Gateway;
- `git` available for the pinned GitHub install command.

The hook is model/provider independent. It does not need an LLM API key.

## Stable install

OpenClaw `2026.6.11` does not install a hook-only pack directly from a `git:` source: that path is handled as an extension plugin and rejects an empty `openclaw.extensions` list. Clone the pinned tag, then install the local checkout:

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git
openclaw plugins install ./openclaw-compact-handoff
openclaw hooks enable compact-handoff
openclaw gateway restart
```

Verify discovery and readiness:

```bash
openclaw hooks info compact-handoff
openclaw hooks check
openclaw gateway health
```

Required result:

- `openclaw hooks info compact-handoff` identifies an `openclaw-managed` hook;
- the hook reports `✓ Ready`;
- its events include `message:preprocessed`, `session:compact:before`, `session:compact:after`, and `agent:bootstrap`;
- the Gateway health check succeeds after restart.

Do not report success if only the repository or files were downloaded.

## Local-source install

For development or offline review:

```bash
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git
cd openclaw-compact-handoff
npm test
npm run postrun:check
openclaw plugins install .
openclaw hooks enable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
```

Use `--force` only when replacing an existing managed copy:

```bash
openclaw plugins install . --force
```

## Upgrade

1. Record the current version and health:

   ```bash
   openclaw --version
   openclaw hooks info compact-handoff
   openclaw gateway health
   ```

2. Read the new release notes and confirm OpenClaw/Node compatibility.
3. Clone the new pinned release to a fresh directory and install that path with `--force`.
4. Restart the Gateway once.
5. Re-run hook readiness and Gateway health checks.
6. If the hook code or OpenClaw version changed, run an isolated no-delivery compaction smoke before relying on it for customer sessions.

Example upgrade shape:

```bash
git clone --branch <new-tag> --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git openclaw-compact-handoff-<new-tag>
openclaw plugins install ./openclaw-compact-handoff-<new-tag> --force
openclaw hooks enable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
openclaw hooks check
openclaw gateway health
```

Never edit OpenClaw's globally installed bundled `dist` files to upgrade this pack.

## Rollback and removal

### Immediate safe rollback

Disable the hook first, then restart:

```bash
openclaw hooks disable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
openclaw gateway health
```

This stops the hook without deleting recovery evidence. It is the preferred first response to an unexpected behavior.

OpenClaw `2026.6.11` does not expose a dedicated hook-pack uninstall command. Do not assume `openclaw plugins uninstall openclaw-compact-handoff` removes a hook pack; on this version it reports that no plugin was found.

If complete file removal is required:

1. keep the hook disabled;
2. stop or restart the Gateway so no handler is active;
3. inspect the authoritative install record under `hooks.internal.installs` with `openclaw config get hooks`;
4. back up the OpenClaw config;
5. remove only the exact managed hook-pack directory and matching install record using the tools supported by the customer's OpenClaw version;
6. restart and verify Gateway health.

Do not delete `memory/session_handoffs/` during an emergency rollback. Those files are recovery evidence. Data deletion is a separate, explicitly approved action.

## Troubleshooting

### Hook is installed but not Ready

Run:

```bash
openclaw hooks info compact-handoff
openclaw hooks check
node --version
```

The hook requires `node`. If OpenClaw itself rejects the Node version, satisfy the requirement for the installed OpenClaw release before retrying.

### Hook is Ready but behavior did not change

Confirm it is enabled and the Gateway was restarted after installation:

```bash
openclaw config get hooks.internal.entries.compact-handoff
openclaw gateway status
```

The configuration should include:

```json
{
  "enabled": true
}
```

### Gateway does not become healthy

Do not repeatedly restart. Disable the hook, restart once, and compare health:

```bash
openclaw hooks disable compact-handoff
openclaw gateway restart
openclaw gateway health
```

Report the exact failing command and error. Do not claim the installation passed.

### Handoff files do not appear

The hook does not write on every message. It writes only when one of its lifecycle/pressure conditions is met. Verify the hook is enabled and allow a real or isolated compaction event. Do not force a production customer session to grow merely to test it; use a disposable no-delivery session.

### Existing pending or lock artifact

Do not delete it blindly. The pack intentionally fails closed when ownership or recovery state is ambiguous. Verify that no live Gateway/handler owns the artifact, preserve a copy, and follow the release's recovery notes before removal.

## Optional compaction settings

The hook functions without these settings. Apply them only after the operator approves a separate configuration change and the values are evaluated against the active model context windows.

Validation used this OpenClaw safeguard shape:

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        keepRecentTokens: 50000,
        reserveTokensFloor: 30000,
        recentTurnsPreserve: 6,
        identifierPolicy: "strict",
        midTurnPrecheck: { enabled: true },
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 60000,
          forceFlushTranscriptBytes: "2mb"
        },
        postIndexSync: "await",
        truncateAfterCompaction: true,
        maxActiveTranscriptBytes: "20mb",
        notifyUser: true
      }
    }
  }
}
```

These values are not universal percentages. OpenClaw calculates pressure using the active model's context window and token/byte estimates. A smaller fallback model can compact earlier.

`keepRecentTokens` and `recentTurnsPreserve` affect what is retained; they are not a universal trigger percentage.

## Privacy and operational boundaries

- The handler makes no network requests and calls no LLM.
- It writes bounded, redacted operational state under the active workspace.
- It must not be granted broader filesystem permissions than the OpenClaw process already has.
- It does not replace backups or durable project state.
- It does not make native compaction summaries infallible.
- Never publish handoff files from a customer workspace as troubleshooting examples.

## Verification report format for AI installers

An AI installer should return a compact factual report:

```text
STATUS: INSTALLED_AND_VERIFIED | BLOCKED | ROLLED_BACK
OpenClaw version: <actual command output>
Node version: <actual command output>
Installed source: v0.2.0
Hook: Ready | Not Ready
Gateway: healthy | unhealthy | not running before install
Config changed: hook enable/install records only | describe any deviation
Tests performed: <actual commands>
Remaining issue: none | exact blocker
```

A timeout, copied file, or zero-byte output is not proof of success.
