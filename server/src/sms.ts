/* ============================================================
   SMS transport — one function, two backends.
   With TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM set,
   messages go out for real via Twilio's REST API (plain fetch, no
   SDK). Without them, sends are SIMULATED: the composed text is
   stored on the quote row and logged, so the whole flow can be
   built, demoed and tested before a provider account exists.
   Never throws — callers get a status they can surface.
   ============================================================ */

export type SmsStatus = "sent" | "simulated" | "failed";

export async function sendSms(to: string, body: string): Promise<SmsStatus> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  // A2P 10DLC traffic delivers through a Messaging Service that's linked to
  // your registered campaign — prefer it when set. A raw From number still
  // works for accounts/countries that don't require 10DLC.
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token || (!from && !messagingServiceSid)) {
    console.log(`[sms simulated] to=${to} :: ${body}`);
    return "simulated";
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else params.set("From", from!);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      console.error(`[sms failed] ${res.status} ${await res.text().catch(() => "")}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[sms failed]", err);
    return "failed";
  }
}

/* NANP-friendly normalization to +E.164; returns null when it can't be a
   real mobile number. "6473490980" → "+16473490980". */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, "");
  if (bare.length === 10) return "+1" + bare;
  if (bare.length === 11 && bare.startsWith("1")) return "+" + bare;
  return null;
}
