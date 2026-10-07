/* The download button and the route must name the same role.
   The desk shows an administrator as Owner. A check against that
   display name would offer the button to the wrong person, or hide
   it from the right one, while the route still checks `administrator`.
   This loads the function the screen calls, rather than copying it. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function loadBackend(): { deskExportAllowed: (role: unknown) => boolean } {
  const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-backend.js"), "utf8");
  const win: { CDOS?: { Backend?: { deskExportAllowed?: (role: unknown) => boolean } } } = {};
  const sandbox = { window: win };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));
  const allowed = win.CDOS?.Backend?.deskExportAllowed;
  if (!allowed) throw new Error("cdos-backend.js did not export deskExportAllowed");
  return { deskExportAllowed: allowed };
}

const backend = loadBackend();

describe("who may download this desk", () => {
  it("allows the server role administrator and nobody the desk shows as Owner", () => {
    expect(backend.deskExportAllowed("administrator")).toBe(true);
    expect(backend.deskExportAllowed("Owner")).toBe(false);
    expect(backend.deskExportAllowed("branch_manager")).toBe(false);
    expect(backend.deskExportAllowed("teller")).toBe(false);
    expect(backend.deskExportAllowed(null)).toBe(false);
    expect(backend.deskExportAllowed(undefined)).toBe(false);
  });
});
