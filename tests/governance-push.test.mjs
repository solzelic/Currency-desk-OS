/* A push to main used to diff origin/ because github.base_ref is empty.
   Run with: node --test tests/governance-push.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { governanceInvocation } from "../scripts/governance-event.mjs";

test("a push does not build a base of origin/", () => {
  const plan = governanceInvocation({ eventName: "push", baseRef: "" });
  assert.equal(plan.run, false);
  assert.equal(plan.fail, undefined);
  assert.equal(plan.base, undefined);
});

test("a pull request still diffs origin/<base>", () => {
  const plan = governanceInvocation({ eventName: "pull_request", baseRef: "main" });
  assert.deepEqual(plan, { run: true, base: "origin/main" });
});

test("a pull request with an empty base does not diff origin/", () => {
  const plan = governanceInvocation({ eventName: "pull_request", baseRef: "" });
  assert.equal(plan.run, false);
  assert.equal(plan.fail, true);
  assert.equal(plan.base, undefined);
});

test("dry run: a push event exits 0", () => {
  const result = spawnSync(process.execPath, ["scripts/run-governance-check.mjs"], {
    env: { ...process.env, EVENT_NAME: "push", BASE_REF: "", PR_BODY: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /push event passes/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /origin\//);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /governance: FAILED/);
});
