import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function check(file, status, staging = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'staging-seam-check-'));
  try {
    const report = path.join(dir, 'report.json');
    writeFileSync(report, JSON.stringify({ suites: [{ file, specs: [{ title: 'real seam', tests: [{ results: [{ status }] }] }] }] }));
    return spawnSync(process.execPath, ['scripts/check-seam-ran.mjs', report, ...(staging ? ['--staging-signin'] : [])], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true }); }
}
test('staging report requires its code seam instead of the ordinary desk gate', () => {
  assert.equal(check('code.spec.ts', 'passed').status, 0);
});
test('staging gate cannot silently skip or select another spec', () => {
  assert.equal(check('code.spec.ts', 'skipped').status, 1);
  assert.equal(check('unrelated.spec.ts', 'passed').status, 1);
});
test('default report still requires the day-at-the-desk gate', () => {
  assert.equal(check('code.spec.ts', 'passed', false).status, 1);
  assert.equal(check('a-day-at-the-desk.spec.ts', 'passed', false).status, 0);
});
