# Instructions for AI Agents and LLM Installers

This file is the authoritative automation guide for this repository.

## Goal

Install **OpenClaw Compact Handoff v0.2.0** as an OpenClaw-managed hook pack, enable it, restart the Gateway once, and prove that both the hook and Gateway are healthy.

The implementation is LLM/provider independent. Do not add model-specific steps.

## Non-negotiable rules

1. Act only after the operator explicitly asks to install, upgrade, or remove this pack.
2. Do not edit OpenClaw's globally installed bundled `dist` files.
3. Do not change model, provider, channel, schedule, memory, or compaction settings as part of installation.
4. Do not read, copy, publish, or delete customer handoff files.
5. Preserve the current OpenClaw configuration and health baseline before mutation.
6. Use a pinned release tag. Do not install a mutable branch for production.
7. Run real verification commands. File presence alone is not success.
8. If a required command fails or times out, report `BLOCKED`; never invent a successful result.
9. On post-install health failure, disable the hook and restart once. Do not loop restarts.
10. Treat handoff-data deletion as a separate destructive action requiring explicit approval.

## Deterministic installation procedure

### 1. Preflight

Run:

```bash
command -v openclaw
command -v node
command -v git
openclaw --version
node --version
openclaw gateway status
openclaw hooks list
```

Record whether the Gateway was healthy/running before installation. If OpenClaw is missing or already unhealthy, stop and report the prerequisite problem instead of attributing it to this pack.

### 2. Install the pinned release

OpenClaw `2026.6.11` routes direct `git:` installs through its extension-plugin path and rejects hook-only packages. Clone the tag first and install the local checkout:

```bash
INSTALL_TMP="$(mktemp -d)"
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git "$INSTALL_TMP/openclaw-compact-handoff"
openclaw plugins install "$INSTALL_TMP/openclaw-compact-handoff"
openclaw hooks enable compact-handoff
```

If and only if replacing an existing managed copy of this pack, create a fresh pinned checkout and use:

```bash
UPGRADE_TMP="$(mktemp -d)"
git clone --branch v0.2.0 --depth 1 https://github.com/JasperYang0609/openclaw-compact-handoff.git "$UPGRADE_TMP/openclaw-compact-handoff"
openclaw plugins install "$UPGRADE_TMP/openclaw-compact-handoff" --force
openclaw hooks enable compact-handoff
```

Do not use `--force` to bypass a security-policy block. The deprecated `--dangerously-force-unsafe-install` flag is not an approved workaround.

### 3. Restart once

```bash
openclaw gateway restart
```

Wait for the command to finish. Do not assume background readiness.

### 4. Verify the installed hook

Run:

```bash
openclaw hooks info compact-handoff
openclaw hooks check
openclaw config get hooks.internal.entries.compact-handoff
```

Required facts:

- source is `openclaw-managed`;
- status is `✓ Ready`;
- events include all four of:
  - `message:preprocessed`
  - `session:compact:before`
  - `session:compact:after`
  - `agent:bootstrap`
- the hook entry is enabled.

### 5. Verify service health

Run:

```bash
openclaw gateway health
openclaw gateway status
```

If channels are configured and the operator permits probes, also run:

```bash
openclaw channels status --probe --json
```

Compare with the preflight baseline. Do not expose credentials or raw private configuration in the report.

### 6. Optional isolated functional test

For production/customer systems, use only a disposable, unique, no-delivery session. Do not send a test message to a real channel and do not reuse an existing customer session.

A valid integration test must:

- use an official OpenClaw session/agent API;
- avoid external delivery;
- trigger or replay the relevant hook lifecycle in isolation;
- verify the expected handoff belongs only to that test session;
- delete the disposable session through the official session API;
- remove only exact test artifacts;
- re-check Gateway health and zero residue.

If the available OpenClaw version does not offer a safe disposable path, skip this step and clearly report that only install/readiness verification was performed.

## Safe rollback

If readiness or Gateway health regresses:

```bash
openclaw hooks disable compact-handoff
openclaw gateway restart
openclaw hooks info compact-handoff
openclaw gateway health
```

OpenClaw `2026.6.11` does not provide a dedicated hook-pack uninstall command. A disabled pack can safely remain installed. Do not claim that `openclaw plugins uninstall openclaw-compact-handoff` removes this hook pack on that version.

Do not delete `memory/session_handoffs/` during rollback.

## Source verification procedure

When reviewing or packaging this repository:

```bash
npm test
npm run postrun:check
npm pack --dry-run
npm run test:ci:workflow-contract
```

All commands must exit successfully. The test suite must leave no temporary-tree residue.

Before pushing, accumulate a reviewable change and run `npm run check:push`. Non-main branches use the focused Ubuntu Branch Check; pull requests and `main` retain the full Ubuntu/macOS matrix. An open PR suppresses duplicate branch tests, superseded runs are cancelled, and genuine failure notifications remain enabled.

## Scope and limitations to explain to the operator

- This pack supplements OpenClaw native compaction; it does not replace the native summarizer.
- It does not choose the native compaction threshold.
- It creates a bounded early handoff at 65% context pressure or 1.5 MB transcript size, then listens to native before/after compaction events.
- It performs no network request and no LLM call.
- It cannot guarantee that every native summary is semantically perfect; it adds continuity, isolation, audit, and recovery defenses.
- Internal hook APIs may change after an OpenClaw upgrade; reverify after every upgrade.

## Required final report

Return exactly grounded facts in this shape:

```text
STATUS: INSTALLED_AND_VERIFIED | BLOCKED | ROLLED_BACK
OpenClaw version: <actual>
Node version: <actual>
Installed source: v0.2.0
Hook readiness: Ready | Not Ready
Gateway health: healthy | unhealthy | not running before install
Verification commands: <actual commands run>
Configuration changes: hook install/enable records only | exact deviation
Functional smoke: passed | skipped with reason | failed
Remaining issue: none | exact blocker
```

Never include API keys, tokens, full private config, customer transcript excerpts, or hidden reasoning.
