/* Shop lock clock, run with TZ=Asia/Jerusalem.

   The parent test spawns this file so the process zone is Jerusalem
   while the branch zone stays America/Toronto. The sentence it prints
   is the one the lock screen shows. */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, schema } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { formatLockClock, ipBucket } from "../src/auth/signin-guard.js";

const outArg = process.argv[2];
if (!outArg) throw new Error("missing result path");
const outPath: string = outArg;

function localClock(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value?.replace(/\s/g, "").toUpperCase();
  if (!hour || !minute || (dayPeriod !== "AM" && dayPeriod !== "PM")) {
    throw new Error("process clock could not be read");
  }
  return `${hour}:${minute} ${dayPeriod}`;
}

async function main(): Promise<void> {
  const handle = await createDb();
  const app = await buildApp(handle.db);
  try {
    await handle.db.update(schema.branches).set({ timezone: "America/Toronto" }).where(eq(schema.branches.id, "br-yorkville"));
    const ip = "192.0.2.77";
    await handle.db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, ipBucket(ip)));
    const staffId = `tz.lock.${Date.now()}`;
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let n = 0; n < 5; n++) {
      last = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        remoteAddress: ip,
        payload: { staffId, password: "wrong-password", tenantId: "tnt-yorkfx" },
      });
    }
    if (!last) throw new Error("no lock response");
    const body = last.json() as { error?: string; until?: string; retryAt?: string; timeZone?: string };
    const retryAt = new Date(String(body.retryAt));
    const toronto = formatLockClock(retryAt, "America/Toronto");
    const jerusalem = formatLockClock(retryAt, "Asia/Jerusalem");
    writeFileSync(outPath, JSON.stringify({
      tz: process.env.TZ,
      status: last.statusCode,
      error: body.error,
      timeZone: body.timeZone,
      until: body.until,
      toronto,
      jerusalem,
      processClock: localClock(retryAt),
      sentence: `Too many tries. Try again at ${body.until}.`,
    }));
  } finally {
    await app.close();
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "lock clock probe failed");
  process.exit(1);
});
