/* Mail for a linked or unlinked identity. The address is the recipient
   only. It is not put in the audit row and it is not logged here. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { sendEmail } from "../email.js";
import { isEmail } from "./login-user.js";

export async function sendIdentityMail(
  db: Db,
  user: { id: string; tenantId: string; staffId: string; email: string | null; name: string },
  event: "linked" | "unlinked",
  provider: "Google" | "Microsoft",
): Promise<boolean> {
  const to = user.email && isEmail(user.email) ? user.email : isEmail(user.staffId) ? user.staffId : null;
  if (!to) return false;
  const shop = (await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, user.tenantId)).limit(1))[0]?.name ?? "your desk";
  const verb = event === "linked" ? "added to" : "removed from";
  const subject = `${provider} was ${verb} your CurrencyDesk sign-in`;
  const text = event === "linked"
    ? `${provider} can now open ${shop}. If this was not you, remove it in Settings and change your password.`
    : `${provider} was removed from ${shop}. If this was not you, change your password.`;
  const sent = await sendEmail(to, subject, { text, sensitive: true });
  return sent !== "failed";
}
