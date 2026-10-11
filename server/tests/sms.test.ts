/* The Twilio flag. sendSms and the phone More list both read it.
   Unset means simulated, which is not configured. */
import { afterEach, describe, expect, it } from "vitest";
import { sendSms, smsConfigured } from "../src/sms.js";

const KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_WHATSAPP_FROM",
] as const;

const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

function clearTwilio(): void {
  for (const key of KEYS) delete process.env[key];
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("smsConfigured", () => {
  it("is false when Twilio is unset, and the send is simulated", async () => {
    clearTwilio();
    expect(smsConfigured()).toBe(false);
    expect(await sendSms("+15555550100", "hello")).toBe("simulated");
  });

  it("is true with an account, a token, and a from number", () => {
    clearTwilio();
    process.env.TWILIO_ACCOUNT_SID = "AC-test";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_FROM = "+15555550199";
    expect(smsConfigured()).toBe(true);
  });

  it("stays false when the from number, the messaging service, and WhatsApp are all missing", () => {
    clearTwilio();
    process.env.TWILIO_ACCOUNT_SID = "AC-test";
    process.env.TWILIO_AUTH_TOKEN = "token";
    expect(smsConfigured()).toBe(false);
  });
});
