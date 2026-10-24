/* A zone read on the caller's own connection.

   Inside a transaction a missing branches table has to roll back
   to a savepoint, or the post that asked for the zone is aborted.
   Outside a transaction that savepoint is refused (25P01), and the
   select still has to run. */
import { describe, expect, it } from "vitest";
import { branchZone } from "../src/ledger/branch-zone.js";

function boom(code: string) {
  const error = new Error("db") as Error & { code?: string };
  error.code = code;
  return error;
}

describe("branch zone", () => {
  it("reads the stored zone when a savepoint is refused outside a transaction", async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.startsWith("SAVEPOINT")) throw boom("25P01");
        if (text.startsWith("SELECT")) return { rows: [{ timezone: " America/Vancouver " }] };
        throw new Error(text);
      },
    };
    await expect(branchZone(client as never, "br-1")).resolves.toBe("America/Vancouver");
    expect(sql.some((text) => text.startsWith("ROLLBACK"))).toBe(false);
    expect(sql.some((text) => text.startsWith("RELEASE"))).toBe(false);
    expect(sql.filter((text) => text.startsWith("SELECT"))).toHaveLength(1);
  });

  it("rolls a missing table back to the savepoint and uses Toronto", async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.startsWith("SELECT")) throw boom("42P01");
        return { rows: [] };
      },
    };
    await expect(branchZone(client as never, "br-1")).resolves.toBe("America/Toronto");
    expect(sql).toContain("ROLLBACK TO SAVEPOINT branch_zone");
    expect(sql).not.toContain("RELEASE SAVEPOINT branch_zone");
  });

  it("does not hide a database error that is not a missing table", async () => {
    const client = {
      query: async (text: string) => {
        if (text.startsWith("SELECT")) throw boom("42703");
        return { rows: [] };
      },
    };
    await expect(branchZone(client as never, "br-1")).rejects.toMatchObject({ code: "42703" });
  });
});
