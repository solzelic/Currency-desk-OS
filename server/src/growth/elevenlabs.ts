import { createHmac, timingSafeEqual } from "node:crypto";
import type { OutboundCallConfig, OutboundCallProvider } from "./calls.js";

export type ElevenLabsRuntime = {
  provider: OutboundCallProvider;
  config: OutboundCallConfig;
  webhookSecret: string | null;
  toolSecret: string | null;
};

const string = (value: string | undefined): string | null => value?.trim() || null;

export function elevenLabsRuntime(env: NodeJS.ProcessEnv = process.env): ElevenLabsRuntime | null {
  const apiKey = string(env.ELEVENLABS_API_KEY);
  const agentId = string(env.ELEVENLABS_AGENT_ID);
  const agentPhoneNumberId = string(env.ELEVENLABS_AGENT_PHONE_NUMBER_ID);
  if (!apiKey || !agentId || !agentPhoneNumberId) return null;
  const recordingEnabled = env.ELEVENLABS_CALL_RECORDING !== "0";

  return {
    config: { agentId, agentPhoneNumberId, recordingEnabled },
    webhookSecret: string(env.ELEVENLABS_WEBHOOK_SECRET),
    toolSecret: string(env.ELEVENLABS_AGENT_TOOL_SECRET),
    provider: {
      name: "elevenlabs",
      async place(request) {
        const response = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agent_id: request.agentId,
            agent_phone_number_id: request.agentPhoneNumberId,
            to_number: request.toNumber,
            call_recording_enabled: request.recordingEnabled,
            conversation_initiation_client_data: {
              conversation_config_override: {
                agent: {
                  first_message: request.firstMessage,
                  prompt: { prompt: request.prompt },
                },
              },
              dynamic_variables: request.dynamicVariables,
            },
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`ElevenLabs rejected the call (${response.status}): ${detail}`);
        }
        const body = await response.json() as Record<string, unknown>;
        if (body.success !== true) throw new Error("ElevenLabs did not accept the call.");
        return {
          providerCallId: typeof body.callSid === "string" ? body.callSid : null,
          conversationId: typeof body.conversation_id === "string" ? body.conversation_id : null,
        };
      },
    },
  };
}

/* This matches ElevenLabs' official SDK verifier: `t=<unix>,v0=<hex>` over
   `${timestamp}.${rawBody}`, with a 30-minute replay tolerance. Keeping the
   small verifier here avoids pulling the full voice SDK into the server just
   for one HMAC operation. */
export function verifyElevenLabsWebhook(input: {
  rawBody: Buffer;
  signature: string;
  secret: string;
  now?: () => number;
}): boolean {
  const parts = input.signature.split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const supplied = parts.find((part) => part.startsWith("v0="))?.slice(3);
  if (!timestamp || !supplied || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const at = Number(timestamp) * 1000;
  const now = input.now?.() ?? Date.now();
  if (!Number.isFinite(at) || at < now - 30 * 60 * 1000 || at > now + 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody.toString("utf8")}`)
    .digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
