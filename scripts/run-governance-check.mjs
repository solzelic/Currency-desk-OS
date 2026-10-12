/* CI entry for the living-docs check.
   EVENT_NAME and BASE_REF come from the workflow env, never from the shell
   command line. On push this exits 0. On pull_request it runs the diff. */
import { spawnSync } from "node:child_process";
import { governanceInvocation } from "./governance-event.mjs";

const plan = governanceInvocation({
  eventName: process.env.EVENT_NAME || "",
  baseRef: process.env.BASE_REF || "",
});

if (!plan.run) {
  if (plan.fail) {
    console.error(plan.message);
    process.exit(1);
  }
  console.log(plan.message);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  ["scripts/check-repository-governance.mjs", "--base", plan.base],
  { stdio: "inherit", env: process.env }
);
process.exit(result.status ?? 1);
