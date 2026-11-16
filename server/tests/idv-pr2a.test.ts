/* Persona PR 2a. Tiers follow Compliance: 1 in person, 2 returning client,
   3 ID and selfie, 4 ID selfie and database (database step off).
   The face crop is a small PNG from the ID photo. Full images and selfies are not stored. */
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { eq } from "drizzle-orm";
import { CONSENT_VERSION, ID_DETAILS_LINE, CROP_LINE, noticeCopy, selfieConsentCopy } from "../src/idv/consent-copy.js";
import { cropIdPortrait, isSmallCrop } from "../src/idv/face-crop.js";
import { decryptSecret, encryptSecret, idNumberKey, maskDocumentNumber } from "../src/idv/id-number.js";
import { readInquiryText, storedInquiryFields } from "../src/idv/inquiry-text.js";
import { cropFromFrontPhoto, fetchPersonaInquiry } from "../src/idv/persona-calls.js";
import { assertPersonaKey, PersonaKeyRefused } from "../src/idv/persona-guard.js";
import { classifyCheck, resolveTier, tierMethod, TIER_NUMBER } from "../src/idv/tiers.js";
import { dbQuery } from "../src/idv/records.js";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs") as { PNG: { new (opts: { width: number; height: number }): { data: Buffer; width: number; height: number }; sync: { write(png: { data: Buffer; width: number; height: number }): Buffer; read(buf: Buffer): { width: number; height: number; data: Buffer } } } };

const NUMBER = "QWERT7788991";
const SELFIE = "SELFIE-TOKEN-XYZ";
const FRONT = "FRONT-URL-TOKEN";

function wideId(): Buffer {
  const png = new PNG({ width: 400, height: 250 });
  for (let y = 0; y < 250; y += 1) {
    for (let x = 0; x < 400; x += 1) {
      const i = (y * 400 + x) * 4;
      const left = x < 150;
      png.data[i] = left ? 210 : 12;
      png.data[i + 1] = left ? 24 : 18;
      png.data[i + 2] = left ? 32 : 190;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("tier numbers", () => {
  it("follows Compliance order and keeps the old words", () => {
    expect(TIER_NUMBER).toEqual({
      "1": "1", "2": "2", "3": "3", "4": "4", quick: "2", verify: "3", plus: "4",
    });
    expect(resolveTier("quick")).toBe("2");
    expect(resolveTier("verify")).toBe("3");
    expect(resolveTier("plus")).toBe("4");
    expect(tierMethod("4")).toMatchObject({ method: "id_and_selfie", databaseStep: "off" });
    expect(tierMethod("4").message).toBe("The database step is not on yet. This check runs ID and selfie.");
    expect(tierMethod("1").method).toBe("in_person");
    expect(tierMethod("3").method).toBe("id_and_selfie");
  });

  it("treats a failed selfie as not a verification", () => {
    expect(classifyCheck("approved", "failed")).toEqual({ result: "method_not_completed", verification: false });
    expect(classifyCheck("declined", "declined")).toEqual({ result: "method_not_completed", verification: false });
    expect(classifyCheck("approved", "abandoned")).toEqual({ result: "method_not_completed", verification: false });
    expect(classifyCheck("approved", "passed").verification).toBe(true);
  });
});

describe("document number key", () => {
  it("round trips, masks the last 4, and fails closed when the ciphertext is changed", async () => {
    const stored = await encryptSecret(NUMBER);
    expect(stored.startsWith("aes-256-gcm$")).toBe(true);
    expect(stored).not.toContain(NUMBER);
    expect(await decryptSecret(stored)).toBe(NUMBER);
    expect(maskDocumentNumber(NUMBER)).toBe("•••• 8991");
    expect(maskDocumentNumber(NUMBER)).not.toContain("QWERT");
    const flipped = `${stored.slice(0, -1)}${stored.endsWith("a") ? "b" : "a"}`;
    await expect(decryptSecret(flipped)).rejects.toThrow("id_number_unreadable");
  });

  it("fails closed on staging and live when the key is unset", () => {
    expect(() => idNumberKey({ STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ NODE_ENV: "production" })).toThrow("id_number_key_unavailable");
    expect(idNumberKey({ NODE_ENV: "test" })).toBe("currencydesk-dev-id-number");
  });
});

describe("persona key assertion", () => {
  it("refuses a production key, an unknown host, and an unprefixed key before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchPersonaInquiry({
      inquiryId: "inq_1", key: "persona_production_fixture", env: { NODE_ENV: "test" }, fetchImpl,
    })).rejects.toBeInstanceOf(PersonaKeyRefused);
    await expect(fetchPersonaInquiry({
      inquiryId: "inq_1", key: "persona_sandbox_fixture",
      env: { NODE_ENV: "test", RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com" }, fetchImpl,
    })).rejects.toBeInstanceOf(PersonaKeyRefused);
    await expect(fetchPersonaInquiry({
      inquiryId: "inq_1", key: "fixture-api-key",
      env: { NODE_ENV: "development" }, fetchImpl,
    })).rejects.toBeInstanceOf(PersonaKeyRefused);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertPersonaKey("fixture-api-key", { NODE_ENV: "development" }, "http://127.0.0.1:9")).not.toThrow();
  });
});

describe("inquiry text and face crop", () => {
  const source = wideId();
  const payload = {
    data: { id: "inq_1", attributes: { status: "approved", "front-photo-url": `https://evil.test/${FRONT}` } },
    included: [
      {
        type: "verification/government-id", id: "ver_g",
        attributes: {
          status: "passed", "name-first": "Ada", "name-last": "Client",
          "identification-number": NUMBER, "id-class": "dl",
          "issuing-subdivision": "ON", "issuing-country": "CA",
          "expiration-date": "2030-01-02", birthdate: "1990-04-05",
          "address-street-1": "1 King St",
          "front-photo-url": `https://files.withpersona.com/${FRONT}.png`,
          "back-photo-url": "https://files.withpersona.com/back.png",
          "selfie-photo-url": `https://files.withpersona.com/${SELFIE}.jpg`,
        },
      },
      {
        type: "verification/selfie", id: "ver_s",
        attributes: { status: "passed", "center-photo-url": `https://files.withpersona.com/${SELFIE}.jpg` },
      },
    ],
  };

  it("drops photo fields and keeps only the ID front url in memory", () => {
    const text = readInquiryText(payload);
    const stored = JSON.stringify(storedInquiryFields(text));
    expect(stored).not.toContain(FRONT);
    expect(stored).not.toContain(SELFIE);
    expect(stored).not.toContain("https://");
    expect(stored).toContain(NUMBER);
    expect(text.frontPhotoUrl).toContain(FRONT);
    expect(text.selfieStatus).toBe("passed");
    expect(JSON.stringify(text)).not.toContain(SELFIE);
  });

  it("stores a small crop of the ID photo and does not fetch the selfie", async () => {
    const crop = cropIdPortrait(source);
    expect(crop).toBeTruthy();
    expect(isSmallCrop(crop!)).toBe(true);
    expect(crop!.equals(source)).toBe(false);
    const pixels = PNG.sync.read(crop!);
    expect(pixels.width).toBe(96);
    expect(pixels.data[0]).toBeGreaterThan(150);
    expect(pixels.data[2]).toBeLessThan(80);
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes(SELFIE)) throw new Error("selfie fetched");
      return new Response(source, { status: 200 });
    };
    const made = await cropFromFrontPhoto({
      url: `https://files.withpersona.com/${FRONT}.png`,
      key: "fixture-api-key", env: { NODE_ENV: "test" }, fetchImpl,
    });
    expect(isSmallCrop(made!)).toBe(true);
    expect(seen).toEqual([`https://files.withpersona.com/${FRONT}.png`]);
    const skipped = await cropFromFrontPhoto({
      url: `https://files.withpersona.com/${SELFIE}.jpg`,
      key: "fixture-api-key", env: { NODE_ENV: "test" }, fetchImpl,
    });
    expect(skipped).toBeNull();
    expect(seen).toHaveLength(1);
    const evil = await cropFromFrontPhoto({
      url: `https://evil.test/${FRONT}`, key: "fixture-api-key", env: { NODE_ENV: "test" }, fetchImpl,
    });
    expect(evil).toBeNull();
  });

  it("keeps the US region line and the 5 year line, and the crop sentence only when the crop is on", () => {
    const fill = {
      legalName: "York Currency Exchange Inc.", privacyContact: "Privacy", privacyEmail: "p@example.com",
      privacyPhone: "416-555-0100", privacyPolicyUrl: "https://example.com/privacy", personaNoticeUrl: "https://withpersona.com/legal/privacy-policy",
      faceCrop: true,
    };
    const on = `${noticeCopy(fill)}\n${selfieConsentCopy(fill)}`;
    const off = `${noticeCopy({ ...fill, faceCrop: false })}\n${selfieConsentCopy({ ...fill, faceCrop: false })}`;
    expect(on).toContain(ID_DETAILS_LINE);
    expect(on).toContain("United States");
    expect(on).toContain(CROP_LINE);
    expect(off).toContain(ID_DETAILS_LINE);
    expect(off).not.toContain(CROP_LINE);
    expect(on.toLowerCase()).not.toContain("stays in canada");
    expect(on.toLowerCase()).not.toContain("stored in canada");
    expect(CONSENT_VERSION).toBe("consent-v0.3.7-draft");
    for (const word of ["verified", "approved", "cleared"]) {
      expect(on.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
    expect(on.toLowerCase()).not.toContain("fintrac approved");
  });
});

describe("id check records", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  const cookies: Record<string, Record<string, string>> = {};
  const source = wideId();
  const seen: string[] = [];
  let inquiries = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    if (url.includes(SELFIE)) throw new Error("selfie fetched");
    if (method === "POST" && url.endsWith("/inquiries")) {
      inquiries += 1;
      return new Response(JSON.stringify({ data: { id: `inq_${inquiries}` } }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("generate-one-time-link")) {
      const body = String(init?.body ?? "");
      expect(body).not.toContain(NUMBER);
      expect(body.length).toBeLessThan(10);
      return new Response(JSON.stringify({ meta: { "one-time-link": "https://inquiry.withpersona.com/verify?code=sandbox" } }), { status: 200 });
    }
    if (url.includes(FRONT)) return new Response(source, { status: 200 });
    if (url.includes("/inquiries/")) {
      return new Response(JSON.stringify({
        data: { id: "inq", type: "inquiry", attributes: { status: "approved" }, relationships: { "inquiry-template": { data: { id: "itmpl_fixture" } } } },
        included: [
          {
            type: "verification/government-id", id: "ver_g",
            attributes: {
              status: "passed", "name-first": "Ada", "name-last": "Client",
              "identification-number": NUMBER, "id-class": "dl",
              "issuing-subdivision": "ON", "issuing-country": "CA", "expiration-date": "2030-01-02",
              "front-photo-url": `https://files.withpersona.com/${FRONT}.png`,
              "back-photo-url": "https://files.withpersona.com/back.png",
            },
          },
          {
            type: "verification/selfie", id: "ver_s",
            attributes: { status: "passed", "center-photo-url": `https://files.withpersona.com/${SELFIE}.jpg` },
          },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };

  function cookieOf(res: { cookies: { name: string; value: string }[] }) {
    return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
  }
  async function signIn(staffId: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId } });
    expect(res.statusCode, res.body).toBe(200);
    return cookieOf(res);
  }

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    delete process.env.DATABASE_URL;
    handle = await createDb();
    await seed(handle.db);
    const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "j.masri")).limit(1);
    for (const person of [
      { staffId: "c.adebayo", name: "C. Adebayo", role: "compliance_officer" as const },
      { staffId: "l.berg", name: "L. Berg", role: "auditor" as const },
    ]) {
      await handle.db.insert(schema.staffUsers).values({
        id: `${DEMO.tenantId}:${person.staffId}`, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId,
        branchId: DEMO.branchId, staffId: person.staffId, name: person.name, role: person.role,
        authorizedBranchIds: [DEMO.branchId], passwordHash: owner[0]!.passwordHash,
      }).onConflictDoNothing();
    }
    await handle.db.insert(schema.tenants).values({ id: "tnt-other", name: "Other Shop" }).onConflictDoNothing();
    await handle.db.insert(schema.legalEntities).values({ id: "le-other", tenantId: "tnt-other", name: "Other Shop", jurisdiction: "FINTRAC" }).onConflictDoNothing();
    app = await buildApp(handle.db, {}, undefined, { env: { NODE_ENV: "test", PERSONA_API_KEY: "fixture-api-key" }, fetch: fetchImpl, sleep: async () => {} });
    cookies.teller = await signIn("m.costa");
    cookies.supervisor = await signIn("a.singh");
    cookies.manager = await signIn("r.haddad");
    cookies.owner = await signIn("j.masri");
    cookies.officer = await signIn("c.adebayo");
    cookies.auditor = await signIn("l.berg");
    await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner,
      payload: { checksEnabled: true, apiKeyRef: "PERSONA_API_KEY", templateId: "itmpl_fixture", faceCropEnabled: true },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (handle) await handle.close();
  });

  async function client(name: string) {
    const id = `cli_${name.replace(/[^a-z]/gi, "").toLowerCase()}_${Math.random().toString(16).slice(2, 8)}`;
    await dbQuery(handle.db).query(
      "INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name) VALUES ($1,$2,$3,$4)",
      [id, DEMO.tenantId, DEMO.legalEntityId, name],
    );
    return id;
  }

  it("stores an in-person record with ciphertext and a masked read", async () => {
    const clientId = await client("In Person");
    const created = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "In Person", documentType: "Passport", documentNumber: NUMBER,
        issuingJurisdiction: "ON", issuingCountry: "CA", expiryDate: "2030-01-02",
        attested: true, dealId: "deal-1", address: "1 King St", dateOfBirth: "1990-04-05",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().maskedNumber).toBe("•••• 8991");
    expect(created.body).not.toContain(NUMBER);
    expect(created.json().photoLine).toBe("No photo on file");
    const row = await dbQuery(handle.db).query("SELECT * FROM idv_check_records WHERE record_id = $1", [created.json().recordId]);
    const dumped = JSON.stringify(row.rows[0]);
    expect(dumped).not.toContain(NUMBER);
    expect(String(row.rows[0]?.document_number_ciphertext)).toMatch(/^aes-256-gcm\$/);
    expect(await decryptSecret(String(row.rows[0]?.document_number_ciphertext))).toBe(NUMBER);
    expect(row.rows[0]?.face_crop_ciphertext).toBeNull();
    expect(row.rows[0]?.deal_id).toBe("deal-1");
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.owner });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.body).not.toContain(NUMBER);
    expect(read.body).toContain("•••• 8991");
    expect(read.body).toContain("photo ID, in person");
    const health = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "In Person", documentType: "Health card", documentNumber: "1234567890",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    expect(health.statusCode).toBe(422);
  });

  it("reveals the number only above teller, audits it, and hides a tampered value", async () => {
    const clientId = await client("Reveal");
    const created = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Reveal", documentType: "Driver's licence", documentNumber: NUMBER,
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    const recordId = created.json().recordId as string;
    expect((await app.inject({ method: "POST", url: `/api/idv/checks/${recordId}/reveal`, cookies: cookies.teller, payload: { reason: "id_mismatch" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/idv/checks/${recordId}/reveal`, cookies: cookies.auditor, payload: { reason: "id_mismatch" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/idv/checks/${recordId}/reveal`, cookies: cookies.supervisor, payload: { reason: "because" } })).statusCode).toBe(400);
    for (const who of ["supervisor", "manager", "officer", "owner"]) {
      const shown = await app.inject({
        method: "POST", url: `/api/idv/checks/${recordId}/reveal`, cookies: cookies[who],
        payload: { reason: "id_mismatch", note: "desk check" },
      });
      expect(shown.statusCode, shown.body).toBe(200);
      expect(shown.json().number).toBe(NUMBER);
    }
    const audit = await dbQuery(handle.db).query("SELECT * FROM idv_number_reveals WHERE record_id = $1", [recordId]);
    expect(audit.rows.length).toBe(4);
    expect(JSON.stringify(audit.rows)).not.toContain(NUMBER);
    const other = await dbQuery(handle.db).query(
      `INSERT INTO staff_users (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, password_hash)
       SELECT 'tnt-other:o.owner', 'tnt-other', 'le-other', $1, 'o.owner', 'Other', 'administrator', password_hash
         FROM staff_users WHERE staff_id = 'j.masri' LIMIT 1
       ON CONFLICT DO NOTHING`,
      [DEMO.branchId],
    );
    void other;
    await dbQuery(handle.db).query(
      "INSERT INTO branches (id, tenant_id, legal_entity_id, name, province) VALUES ('br-other','tnt-other','le-other','Other','ON') ON CONFLICT DO NOTHING",
    );
    const flipped = await dbQuery(handle.db).query("SELECT document_number_ciphertext FROM idv_check_records WHERE record_id = $1", [recordId]);
    const cipher = String(flipped.rows[0]?.document_number_ciphertext);
    const broken = `${cipher.slice(0, -1)}${cipher.endsWith("a") ? "b" : "a"}`;
    await expect(dbQuery(handle.db).query("UPDATE idv_check_records SET document_number_ciphertext = $2 WHERE record_id = $1", [recordId, broken])).rejects.toThrow(/append-only/);
  });

  it("refuses returning client until this shop has a full check, and still runs with no photo", async () => {
    const clientId = await client("Return");
    const first = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: false },
    });
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toBe("no_earlier_check");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, name_on_id)
       VALUES ('idc_other_shop','tnt-other','le-other','br-other',$1,'1','in_person','pass','o.owner','Return')`,
      [clientId],
    );
    const otherShop = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: false },
    });
    expect(otherShop.statusCode).toBe(409);
    const made = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Return", documentType: "Passport", documentNumber: "ABC1234567",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const doubt = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: false, detailsChanged: false, doubtReason: "face does not match", pepAnswer: false },
    });
    expect(doubt.statusCode).toBe(409);
    expect(doubt.json().error).toBe("doubt");
    const blocks = await dbQuery(handle.db).query("SELECT reason FROM idv_returning_blocks WHERE client_id = $1", [clientId]);
    expect(blocks.rows[0]?.reason).toBe("face does not match");
    const changed = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: true, pepAnswer: false },
    });
    expect(changed.statusCode).toBe(409);
    const used = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: false, dealId: "deal-r" },
    });
    expect(used.statusCode, used.body).toBe(200);
    expect(used.json().photoLine).toBe("No photo on file");
    expect(used.json().persona).toBe(false);
    expect(used.json().originalRecordId).toBe(made.json().recordId);
    const link = await dbQuery(handle.db).query("SELECT deal_id FROM idv_check_deals WHERE record_id = $1", [used.json().recordId]);
    expect(link.rows[0]?.deal_id).toBe("deal-r");
  });

  it("blocks returning client at 5 years and advises from 3", async () => {
    const aged = await client("Aged");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, verified_at)
       VALUES ('idc_aged',$1,$2,$3,$4,'1','in_person','pass','m.costa', now() - interval '5 years' - interval '1 day')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, aged],
    );
    const due = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId: aged, noDoubts: true, detailsChanged: false, pepAnswer: false },
    });
    expect(due.statusCode).toBe(409);
    expect(due.json().message).toBe("A new full ID check is needed.");
    const mid = await client("Mid");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, verified_at)
       VALUES ('idc_mid',$1,$2,$3,$4,'3','id_and_selfie','pass','m.costa', now() - interval '3 years' - interval '1 day')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, mid],
    );
    const advice = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId: mid, noDoubts: true, detailsChanged: false, pepAnswer: true },
    });
    expect(advice.statusCode, advice.body).toBe(200);
    expect(advice.json().advice).toBe("A new ID and selfie check is advised.");
  });

  it("requires consent for the link, refuses Quebec, and runs tier 4 as ID and selfie", async () => {
    const clientId = await client("Link");
    const before = seen.length;
    const started = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller,
      payload: { clientId, tier: "3" },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().tier).toBe("3");
    const inquiryId = started.json().providerRef as string;
    const blocked = await app.inject({
      method: "POST", url: `/api/idv/inquiries/${inquiryId}/one-time-link`, cookies: cookies.teller, payload: {},
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("consent_required");
    const consent = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", inquiryId },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const row = await dbQuery(handle.db).query("SELECT copy_version, language, inquiry_id, staff_id, recorded_at FROM idv_consents WHERE consent_id = $1", [consent.json().consentId]);
    expect(row.rows[0]?.copy_version).toBe(CONSENT_VERSION);
    expect(row.rows[0]?.language).toBe("en");
    expect(row.rows[0]?.inquiry_id).toBe(inquiryId);
    expect(row.rows[0]?.staff_id).toBe("m.costa");
    expect(row.rows[0]?.recorded_at).toBeTruthy();
    const link = await app.inject({
      method: "POST", url: `/api/idv/inquiries/${inquiryId}/one-time-link`, cookies: cookies.teller, payload: {},
    });
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json().url).toContain("https://inquiry.withpersona.com/");
    expect(seen.length).toBeGreaterThan(before);
    await dbQuery(handle.db).query("UPDATE branches SET province = 'QC' WHERE id = $1", [DEMO.branchId]);
    const quebec = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId, tier: "3" },
    });
    expect(quebec.statusCode).toBe(409);
    expect(quebec.json().message).toBe("Face match is off for this branch. Inspect the original ID.");
    const quebecLink = await app.inject({
      method: "POST", url: `/api/idv/inquiries/${inquiryId}/one-time-link`, cookies: cookies.teller, payload: {},
    });
    expect(quebecLink.statusCode).toBe(409);
    const counter = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Link", documentType: "Passport", documentNumber: "PASS998877",
        issuingJurisdiction: "QC", issuingCountry: "CA", attested: true,
      },
    });
    expect(counter.statusCode, counter.body).toBe(200);
    await dbQuery(handle.db).query("UPDATE branches SET province = NULL WHERE id = $1", [DEMO.branchId]);
    const unknown = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId, tier: "verify" },
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().message).toContain("province");
    await dbQuery(handle.db).query("UPDATE branches SET province = 'ON' WHERE id = $1", [DEMO.branchId]);
    const plus = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId, tier: "plus" },
    });
    expect(plus.statusCode, plus.body).toBe(200);
    expect(plus.json().databaseStep).toBe("off");
    expect(plus.json().message).toBe("The database step is not on yet. This check runs ID and selfie.");
    const thanks = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "counter_check", language: "en" },
    });
    expect(thanks.json().persona).toBe(false);
    expect(thanks.json().tellerLine).toBe("Customer chose the counter check. Inspect the original ID.");
  });

  it("stores only the face crop from the ID photo", async () => {
    const clientId = await client("Crop");
    const imagesBefore = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM desk_client_images");
    const started = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller,
      payload: { clientId, tier: "4" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const inquiryId = started.json().providerRef as string;
    const referenceId = started.json().referenceId as string;
    const raw = JSON.stringify({
      data: { id: "evt_crop", attributes: { name: "inquiry.approved", payload: { data: { id: inquiryId, attributes: { status: "approved", "reference-id": referenceId } } } } },
    });
    const { createHmac } = await import("node:crypto");
    const secret = "fixture-webhook-secret";
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(raw)])).digest("hex");
    const local = await buildApp(handle.db, {}, undefined, {
      env: { NODE_ENV: "test", PERSONA_API_KEY: "fixture-api-key", PERSONA_WEBHOOK_SECRET: secret },
      fetch: fetchImpl, sleep: async () => {}, persona: (await import("../src/idv/providers/persona/index.js")).createPersonaProvider({ PERSONA_WEBHOOK_SECRET: secret }),
    });
    try {
      const hook = await local.inject({
        method: "POST", url: "/api/webhooks/idv/persona", payload: raw,
        headers: { "content-type": "application/json", "persona-signature": `t=${t},v1=${mac}` },
      });
      expect(hook.statusCode, hook.body).toBe(200);
    } finally {
      await local.close();
    }
    expect(seen.some((call) => call.includes(SELFIE))).toBe(false);
    expect(seen.some((call) => call.includes(FRONT))).toBe(true);
    const row = await dbQuery(handle.db).query(
      "SELECT * FROM idv_check_records WHERE persona_inquiry_id = $1",
      [inquiryId],
    );
    expect(row.rows.length).toBe(1);
    const dumped = JSON.stringify(row.rows[0]);
    expect(dumped).not.toContain(SELFIE);
    expect(dumped).not.toContain(FRONT);
    expect(dumped).not.toContain(NUMBER);
    expect(dumped).not.toContain("https://");
    const crop = Buffer.from(await decryptSecret(String(row.rows[0]?.face_crop_ciphertext)), "base64");
    expect(isSmallCrop(crop)).toBe(true);
    expect(crop.equals(source)).toBe(false);
    expect(row.rows[0]?.database_step).toBe("off");
    expect(row.rows[0]?.result).toBe("pass");
    const imagesAfter = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM desk_client_images");
    expect(imagesAfter.rows[0]?.n).toBe(imagesBefore.rows[0]?.n);
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(read.body).not.toContain(NUMBER);
    expect(read.json().records[0].photoOnFile).toBe(true);
    const view = await app.inject({
      method: "POST", url: `/api/idv/checks/${row.rows[0]?.record_id}/face`, cookies: cookies.teller,
      payload: { reason: "eye_comparison" },
    });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().contentType).toBe("image/png");
    const viewed = Buffer.from(view.json().dataBase64, "base64");
    expect(viewed.equals(source)).toBe(false);
    expect(isSmallCrop(viewed)).toBe(true);
    const audit = await dbQuery(handle.db).query("SELECT * FROM idv_crop_views WHERE record_id = $1", [row.rows[0]?.record_id]);
    expect(audit.rows.length).toBe(1);
    expect(JSON.stringify(audit.rows)).not.toContain(view.json().dataBase64);
    expect((await app.inject({
      method: "POST", url: `/api/idv/checks/${row.rows[0]?.record_id}/face`, cookies: cookies.auditor,
      payload: { reason: "eye_comparison" },
    })).statusCode).toBe(403);
    await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: false },
    });
    const hidden = await app.inject({
      method: "POST", url: `/api/idv/checks/${row.rows[0]?.record_id}/face`, cookies: cookies.teller,
      payload: { reason: "eye_comparison" },
    });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json().message).toBe("No photo on file");
    const still = await dbQuery(handle.db).query("SELECT face_crop_ciphertext FROM idv_check_records WHERE record_id = $1", [row.rows[0]?.record_id]);
    expect(String(still.rows[0]?.face_crop_ciphertext)).toMatch(/^aes-256-gcm\$/);
    await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true },
    });
    const newer = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Crop Two", documentType: "Passport", documentNumber: "ZZ99887766",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    const marked = await app.inject({
      method: "POST", url: `/api/idv/checks/${row.rows[0]?.record_id}/supersede`, cookies: cookies.owner,
      payload: { replacedByRecordId: newer.json().recordId },
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const name = await dbQuery(handle.db).query("SELECT name_on_id FROM idv_check_records WHERE record_id = $1", [row.rows[0]?.record_id]);
    expect(name.rows[0]?.name_on_id).toBe("Ada Client");
    await expect(dbQuery(handle.db).query("DELETE FROM idv_check_records WHERE record_id = $1", [row.rows[0]?.record_id])).rejects.toThrow(/append-only/);
  });
});
