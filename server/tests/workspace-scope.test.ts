/* ============================================================
   A second till at the branch must not deny the session's own drawer.

   The money routes used to resolve an unscoped request as "the only
   workspace at this branch". Adding a till through the product's own
   route made every caller that omitted x-workspace-id fail with
   SCOPE_DENIED. This pins the replacement rule: the header names a
   till, and without it the session's workspace is used.
   ============================================================ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { createSession, resolveSession, setSessionWorkspace } from "../src/auth/sessions.js";
import { resolveWorkspaceForUser } from "../src/auth/workspace-scope.js";

const SECOND = "ws-yorkville-till-02";

let handle: DbHandle;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.insert(schema.workspaces).values({
    id: SECOND,
    tenantId: DEMO.tenantId,
    legalEntityId: DEMO.legalEntityId,
    branchId: DEMO.branchId,
    tillId: "till-02",
  });
});

afterAll(async () => {
  await handle.close();
});

describe("session workspace resolution", () => {
  it("stamps the home till on sign-in and keeps answering for it after a second till exists", async () => {
    const { token } = await createSession(handle.db, `${DEMO.tenantId}:a.singh`);
    const user = await resolveSession(handle.db, token);
    expect(user?.workspaceId).toBe(DEMO.workspaceId);

    const unscoped = await resolveWorkspaceForUser(handle.db, user!, undefined, token);
    expect(unscoped?.id).toBe(DEMO.workspaceId);
    expect(unscoped?.tillId).toBe("till-01");
  });

  it("lets a named second workspace post while an unscoped call stays on the session till", async () => {
    const { token } = await createSession(handle.db, `${DEMO.tenantId}:a.singh`);
    const user = await resolveSession(handle.db, token);
    expect(user).toBeTruthy();

    const named = await resolveWorkspaceForUser(handle.db, user!, SECOND, token);
    expect(named?.id).toBe(SECOND);
    expect(named?.tillId).toBe("till-02");

    const stillHome = await resolveWorkspaceForUser(handle.db, user!, undefined, token);
    expect(stillHome?.id).toBe(DEMO.workspaceId);
  });

  it("moves the session workspace when the operator selects a till", async () => {
    const { token } = await createSession(handle.db, `${DEMO.tenantId}:a.singh`);
    await setSessionWorkspace(handle.db, token, SECOND);
    const user = await resolveSession(handle.db, token);
    expect(user?.workspaceId).toBe(SECOND);

    const unscoped = await resolveWorkspaceForUser(handle.db, user!, undefined, token);
    expect(unscoped?.id).toBe(SECOND);
  });

  it("refuses a workspace that is not on this session's branch", async () => {
    const { token } = await createSession(handle.db, `${DEMO.tenantId}:a.singh`);
    const user = await resolveSession(handle.db, token);
    const refused = await resolveWorkspaceForUser(handle.db, user!, "ws-missing", token);
    expect(refused).toBeUndefined();
  });
});
