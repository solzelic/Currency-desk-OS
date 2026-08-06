# Growth pipeline

The growth pipeline begins with an early-access application and adds two
separate, append-only histories beside it: sourced research and outbound call
attempts. It never rewrites what the applicant submitted.

## Provenance boundary

- `enquiries.details` is applicant-stated data only.
- `enquiry_contact_consents` records server/browser evidence about submission:
  timestamp, form version, IP, user agent and browser-observed timezone.
- `enquiry_research_runs` and `enquiry_research_facts` hold immutable research
  snapshots. Every stored fact has a non-empty source URL, method and
  confidence. A re-run adds a new snapshot.
- `enquiry_calls` holds one row per attempted call. The unique trigger key is
  reserved before the provider request so a retry cannot dial twice.

## Research setup

Set `TAVILY_API_KEY`. The manual Research action makes separate searches for
the submitted website, the business generally, and the public FINTRAC MSB
registry. Results retain their URLs and Tavily scores. The response's usage
credits are stored on the run. Set `TAVILY_CREDIT_COST_CENTS` to the effective
price of a credit on the account if dollar cost should also be shown; when it
is absent, cost is shown as unpriced rather than zero.

## ElevenLabs setup

Set:

```text
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
ELEVENLABS_AGENT_PHONE_NUMBER_ID
ELEVENLABS_WEBHOOK_SECRET
ELEVENLABS_AGENT_TOOL_SECRET
ELEVENLABS_CALL_RECORDING=1
```

Import the Twilio number into ElevenLabs, allow first-message and prompt
overrides on the agent, and configure the workspace post-call transcription
webhook at:

```text
POST https://<public-origin>/api/webhooks/elevenlabs
```

Use HMAC authentication and save its secret as
`ELEVENLABS_WEBHOOK_SECRET`. The endpoint verifies the raw body, signature and
timestamp before accepting a transcript.

Configure an agent webhook tool for an immediate do-not-contact request:

```text
POST https://<public-origin>/api/webhooks/elevenlabs/do-not-contact
Authorization: Bearer <ELEVENLABS_AGENT_TOOL_SECRET>

{
  "enquiryId": "{{enquiry_id}}",
  "conversationId": "{{system__conversation_id}}",
  "reason": "requested during call"
}
```

The tool accepts only a conversation already recorded against that enquiry.
The agent prompt also instructs the agent to invoke it immediately when asked.

## Safety gates

Every call is refused unless all of these are true:

1. The database kill switch is enabled from the admin panel.
2. ElevenLabs is fully configured.
3. A consent-evidence row exists.
4. The applicant supplied a valid E.164 number. Research-discovered numbers
   are never dialled.
5. The application is not marked do-not-contact.
6. A completed research run exists.
7. The current time is between 09:00 and 21:00 in the lead's sourced or
   browser-observed timezone.
8. The request carries an idempotency key that has not already reserved a
   different call.

The first message identifies SAM as an AI and announces recording whenever
recording is enabled. Do-not-contact can be set by an operator or by the agent
tool and is never cleared automatically.

Official provider references:

- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [ElevenLabs Twilio outbound call](https://elevenlabs.io/docs/api-reference/twilio/outbound-call/)
- [ElevenLabs post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
