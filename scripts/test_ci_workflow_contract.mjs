import fs from 'node:fs';

const full = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const branch = fs.readFileSync('.github/workflows/branch-check.yml', 'utf8');

for (const text of ['branches: [main]', 'pull_request:', 'workflow_dispatch:', 'cancel-in-progress: true', 'macos-latest', 'npm run test:ci:workflow-contract']) {
  if (!full.includes(text)) throw new Error(`full CI missing: ${text}`);
}
for (const text of ['branches-ignore: [main]', 'pull-requests: read', 'gh api --method GET', "if: needs.detect-open-pr.outputs.exists != 'true'", 'npm run check:push']) {
  if (!branch.includes(text)) throw new Error(`branch CI missing: ${text}`);
}
if (branch.includes('macos-latest')) throw new Error('branch CI must remain Ubuntu-only');
console.log('CI workflow contract checks passed');
