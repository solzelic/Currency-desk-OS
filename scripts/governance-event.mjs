/* How Governance chooses a diff on each GitHub event.
   A push to main has no github.base_ref and no pull request body.
   Diffing "origin/" (empty base) makes git exit 1 on every push.
   Diffing origin/main checks nothing: after checkout, that ref is HEAD.
   Diffing HEAD~1 drops the review checkbox, so a merge that recorded
   "no change required" in the pull request body fails after it lands.
   The meaningful diff stays on pull_request. A push exits 0. */

export function governanceInvocation({ eventName, baseRef }) {
  if (eventName === "push") {
    return {
      run: false,
      message:
        "governance: push event passes. The diff runs on pull_request, where the base ref and the review body exist.",
    };
  }
  const ref = String(baseRef ?? "").trim();
  if (!ref) {
    return {
      run: false,
      fail: true,
      message:
        "governance: pull_request is missing a base ref, so the diff was not run against origin/.",
    };
  }
  return { run: true, base: `origin/${ref}` };
}
