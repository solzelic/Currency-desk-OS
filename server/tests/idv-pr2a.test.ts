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
import { decryptSecret, encryptSecret, idNumberKey, KEY_VERSION, maskDocumentNumber, PURPOSE_CROP, PURPOSE_NUMBER } from "../src/idv/id-number.js";
import { personaFileHost, readInquiryText, storedInquiryFields } from "../src/idv/inquiry-text.js";
import { cropFromFrontPhoto, fetchPersonaInquiry } from "../src/idv/persona-calls.js";
import { assertPersonaKey, PersonaKeyRefused } from "../src/idv/persona-guard.js";
import { classifyCheck, resolveTier, tierMethod, TIER_NUMBER } from "../src/idv/tiers.js";
import { dbQuery } from "../src/idv/records.js";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs") as { PNG: { new (opts: { width: number; height: number }): { data: Buffer; width: number; height: number }; sync: { write(png: { data: Buffer; width: number; height: number }): Buffer; read(buf: Buffer): { width: number; height: number; data: Buffer } } } };

const NUMBER = "TEST000000001";
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
  const bind = { purpose: PURPOSE_NUMBER, tenantId: "tnt-a", recordId: "idc_unit" } as const;

  it("round trips, masks the last 4, and fails closed when the ciphertext is changed", async () => {
    const env = { NODE_ENV: "test" };
    const stored = await encryptSecret(NUMBER, bind, env);
    const again = await encryptSecret(NUMBER, bind, env);
    expect(stored.startsWith("aes-256-gcm$")).toBe(true);
    expect(stored).not.toContain(NUMBER);
    expect(stored.split("$")[1]).not.toBe(again.split("$")[1]);
    expect(Buffer.from(stored.split("$")[1] ?? "", "base64")).toHaveLength(12);
    expect(await decryptSecret(stored, bind, env)).toBe(NUMBER);
    expect(maskDocumentNumber(NUMBER)).toBe("•••• 0001");
    expect(maskDocumentNumber(NUMBER)).not.toContain("TEST");
    const parts = stored.split("$");
    const body = parts[3] ?? "";
    const at = body.search(/[A-Za-z0-9]/);
    parts[3] = `${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}`;
    const flipped = parts.join("$");
    await expect(decryptSecret(flipped, bind, env)).rejects.toThrow("id_number_unreadable");
    await expect(decryptSecret(stored, { ...bind, recordId: "idc_other" }, env)).rejects.toThrow("id_number_unreadable");
    await expect(decryptSecret(stored, { ...bind, tenantId: "tnt-b" }, env)).rejects.toThrow("id_number_unreadable");
    await expect(decryptSecret(stored, { ...bind, purpose: PURPOSE_CROP }, env)).rejects.toThrow("id_number_unreadable");
    const previous = { NODE_ENV: "test", ID_NUMBER_KEY: "next-root", ID_NUMBER_KEY_PREVIOUS: "currencydesk-dev-id-number" };
    expect(await decryptSecret(stored, bind, previous)).toBe(NUMBER);
    await expect(decryptSecret(stored, bind, { NODE_ENV: "test", ID_NUMBER_KEY: "next-root" })).rejects.toThrow("id_number_unreadable");
  });

  it("encrypts with the current key and never the previous one", async () => {
    const env = { NODE_ENV: "test", ID_NUMBER_KEY: "current-root", ID_NUMBER_KEY_PREVIOUS: "old-root" };
    const stored = await encryptSecret(NUMBER, bind, env);
    expect(await decryptSecret(stored, bind, { NODE_ENV: "test", ID_NUMBER_KEY: "current-root" })).toBe(NUMBER);
    await expect(decryptSecret(stored, bind, { NODE_ENV: "test", ID_NUMBER_KEY: "old-root" })).rejects.toThrow("id_number_unreadable");
    await expect(encryptSecret(NUMBER, bind, { NODE_ENV: "development", RENDER_EXTERNAL_HOSTNAME: "unknown.example", ID_NUMBER_KEY_PREVIOUS: "old-root" })).rejects.toThrow("id_number_key_unavailable");
  });

  it("fails closed on staging and live when the key is unset", () => {
    expect(() => idNumberKey({ STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ RENDER_EXTERNAL_HOSTNAME: "currencydeskos.com" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ NODE_ENV: "production" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ NODE_ENV: "development", RENDER_EXTERNAL_HOSTNAME: "unknown.example" })).toThrow("id_number_key_unavailable");
    expect(() => idNumberKey({ NODE_ENV: "test", RENDER_EXTERNAL_HOSTNAME: "localhost" })).toThrow("id_number_key_unavailable");
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
          "expiration-date": "2030-01-02", birthdate: "2000-01-01",
          "address-street-1": "TEST Street 0",
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

  it("keeps the wide-card crop inside the left half", () => {
    const width = 400;
    const height = 250;
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const right = x >= width / 2;
        png.data[i] = right ? 0 : 240;
        png.data[i + 1] = 0;
        png.data[i + 2] = right ? 240 : 0;
        png.data[i + 3] = 255;
      }
    }
    const crop = cropIdPortrait(PNG.sync.write(png));
    const pixels = PNG.sync.read(crop!);
    for (let i = 0; i < pixels.data.length; i += 4) {
      expect(pixels.data[i]).toBeGreaterThan(200);
      expect(pixels.data[i + 2]).toBeLessThan(30);
    }
  });

  it("accepts only port 443 and stops a download over 6 MB", async () => {
    expect(personaFileHost("https://files.withpersona.com/a.png")).toBe(true);
    expect(personaFileHost("https://files.withpersona.com:443/a.png")).toBe(true);
    expect(personaFileHost("https://files.withpersona.com:8443/a.png")).toBe(false);
    let pulled = false;
    const declared = await cropFromFrontPhoto({
      url: "https://files.withpersona.com/front.png",
      key: "fixture-api-key",
      env: { NODE_ENV: "test" },
      fetchImpl: async () => ({
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "6000001" : null) },
        body: {
          getReader() {
            pulled = true;
            throw new Error("body read");
          },
          cancel: async () => {},
        },
        arrayBuffer: async () => { pulled = true; return new ArrayBuffer(0); },
      }) as unknown as Response,
    });
    expect(declared).toBeNull();
    expect(pulled).toBe(false);
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024);
    const streamed = await cropFromFrontPhoto({
      url: "https://files.withpersona.com/front.png",
      key: "fixture-api-key",
      env: { NODE_ENV: "test" },
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            async read() {
              return { done: false, value: chunk };
            },
            async cancel() { cancelled = true; },
          }),
        },
      }) as unknown as Response,
    });
    expect(streamed).toBeNull();
    expect(cancelled).toBe(true);
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
    expect(CONSENT_VERSION).toBe("consent-v0.3.9-draft");
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
  let inquiryExpiry = "2030-01-02";
  let refuseLink = false;

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
      const link = refuseLink
        ? "http://127.0.0.1:4199/sandbox-check"
        : "https://inquiry.withpersona.com/verify?code=sandbox";
      return new Response(JSON.stringify({ meta: { "one-time-link": link } }), { status: 200 });
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
              "issuing-subdivision": "ON", "issuing-country": "CA", "expiration-date": inquiryExpiry,
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
        attested: true, dealId: "deal-1", address: "TEST Street 0", dateOfBirth: "2000-01-01",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().maskedNumber).toBe("•••• 0001");
    expect(created.body).not.toContain(NUMBER);
    expect(created.json().photoLine).toBe("No photo on file");
    const row = await dbQuery(handle.db).query("SELECT * FROM idv_check_records WHERE record_id = $1", [created.json().recordId]);
    const dumped = JSON.stringify(row.rows[0]);
    expect(dumped).not.toContain(NUMBER);
    expect(String(row.rows[0]?.document_number_ciphertext)).toMatch(/^aes-256-gcm\$/);
    expect(Number(row.rows[0]?.key_version)).toBe(KEY_VERSION);
    expect(await decryptSecret(String(row.rows[0]?.document_number_ciphertext), {
      purpose: PURPOSE_NUMBER, tenantId: DEMO.tenantId, recordId: created.json().recordId,
    }, { NODE_ENV: "test" })).toBe(NUMBER);
    expect(row.rows[0]?.face_crop_ciphertext).toBeNull();
    expect(row.rows[0]?.deal_id).toBe("deal-1");
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.owner });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.body).not.toContain(NUMBER);
    expect(read.body).toContain("•••• 0001");
    expect(read.body).toContain("photo ID, in person");
    const health = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "In Person", documentType: "Health card", documentNumber: "TEST000000008",
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
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "no" },
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
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "no" },
    });
    expect(otherShop.statusCode).toBe(409);
    const made = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Return", documentType: "Passport", documentNumber: "TEST000000009",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const doubt = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: false, detailsChanged: false, doubtReason: "face does not match", pepAnswer: "no" },
    });
    expect(doubt.statusCode).toBe(409);
    expect(doubt.json().error).toBe("doubt");
    const blocks = await dbQuery(handle.db).query("SELECT reason FROM idv_returning_blocks WHERE client_id = $1", [clientId]);
    expect(blocks.rows[0]?.reason).toBe("face does not match");
    const changed = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: true, pepAnswer: "no" },
    });
    expect(changed.statusCode).toBe(409);
    const used = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "no", dealId: "deal-r" },
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
      payload: { clientId: aged, noDoubts: true, detailsChanged: false, pepAnswer: "no" },
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
      payload: { clientId: mid, noDoubts: true, detailsChanged: false, pepAnswer: "yes" },
    });
    expect(advice.statusCode, advice.body).toBe(200);
    expect(advice.json().advice).toBe("A new ID and selfie check is advised.");
  });

  it("appends a PEP Yes, flags it for review, and still posts the deal", async () => {
    const clientId = await client("Pep Yes");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         document_number_last4, expiry_date, verified_at)
       VALUES ('idc_pep',$1,$2,$3,$4,'3','id_and_selfie','pass','m.costa','0001','2030-01-02', now())`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    const saved = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "yes" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().result).toBe("returning_confirmed");
    const again = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "not_asked" },
    });
    expect(again.statusCode, again.body).toBe(200);
    const answers = await dbQuery(handle.db).query(
      "SELECT answer, staff_id FROM client_pep_answer_events WHERE client_id = $1 ORDER BY answered_at, answer_id",
      [clientId],
    );
    expect(answers.rows.map((row) => row.answer)).toEqual(["yes", "not_asked"]);
    expect(answers.rows.every((row) => row.staff_id === "m.costa")).toBe(true);
    await expect(dbQuery(handle.db).query("UPDATE client_pep_answer_events SET answer = 'no' WHERE client_id = $1", [clientId])).rejects.toThrow(/append-only/);
    await expect(dbQuery(handle.db).query("DELETE FROM client_pep_answer_events WHERE client_id = $1", [clientId])).rejects.toThrow(/append-only/);
    const kept = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM client_pep_answer_events WHERE client_id = $1", [clientId]);
    expect(kept.rows[0]?.n).toBe(2);
    const stale = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toBe("This form is out of date. Reload the page and answer again.");
    const reviews = await dbQuery(handle.db).query(
      "SELECT status FROM client_pep_reviews WHERE client_id = $1",
      [clientId],
    );
    expect(reviews.rows).toEqual([{ status: "open" }]);
    const made = await app.inject({
      method: "POST", url: "/api/quotes", cookies: cookies.teller,
      payload: { customerId: clientId, from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "0.00", direction: "customer_buy_foreign" },
    });
    expect(made.statusCode, made.body).not.toBe(409);
    expect(made.body.toLowerCase()).not.toContain("politically exposed");
    if (made.statusCode === 201) {
      const posted = await app.inject({
        method: "POST", url: `/api/quotes/${made.json().quoteId}/post`, cookies: cookies.teller,
        payload: { idempotencyKey: `pep-${Date.now()}`, purpose: "Personal travel", sourceOfFunds: "Employment income" },
      });
      expect(posted.statusCode, posted.body).not.toBe(409);
      expect(posted.body.toLowerCase()).not.toContain("politically exposed");
    }
  });

  it("refuses a one-time link that is not https on a Persona host", async () => {
    const clientId = await client("Bad Link");
    const started = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller,
      payload: { clientId, tier: "3" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const inquiryId = started.json().providerRef as string;
    await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId },
    });
    refuseLink = true;
    const link = await app.inject({
      method: "POST", url: `/api/idv/inquiries/${inquiryId}/one-time-link`, cookies: cookies.teller, payload: {},
    });
    refuseLink = false;
    expect(link.statusCode).toBe(502);
    expect(link.json().error).toBe("link_failed");
  });

  it("does not store consent when the notice the customer saw no longer matches", async () => {
    const clientId = await client("Copy Flip");
    const before = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_consents WHERE client_id = $1", [clientId]);
    const mismatch = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "counter_check", language: "en", copyVersion: "consent-old", faceCropShown: true },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("consent_copy_changed");
    const after = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_consents WHERE client_id = $1", [clientId]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("refuses consent when the crop sentence changes after the notice was read", async () => {
    const clientId = await client("Crop Both");
    const count = async () => {
      const rows = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_consents WHERE client_id = $1", [clientId]);
      return rows.rows[0]?.n;
    };
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true } });
    const seenOn = await app.inject({ method: "GET", url: "/api/idv/consent-copy", cookies: cookies.teller });
    expect(seenOn.statusCode).toBe(200);
    expect(seenOn.json().faceCrop).toBe(true);
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: false } });
    const beforeOff = await count();
    const turnedOff = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: seenOn.json().version, faceCropShown: true },
    });
    expect(turnedOff.statusCode).toBe(409);
    expect(turnedOff.json().code).toBe("consent_copy_changed");
    expect(await count()).toBe(beforeOff);

    const seenOff = await app.inject({ method: "GET", url: "/api/idv/consent-copy", cookies: cookies.teller });
    expect(seenOff.json().faceCrop).toBe(false);
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true } });
    const beforeOn = await count();
    const turnedOn = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: seenOff.json().version, faceCropShown: false },
    });
    expect(turnedOn.statusCode).toBe(409);
    expect(turnedOn.json().code).toBe("consent_copy_changed");
    expect(await count()).toBe(beforeOn);
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
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId },
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
    const quebecBare = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId },
    });
    expect(quebecBare.statusCode).toBe(409);
    expect(quebecBare.json().message).toBe("Face match is off for this branch. Inspect the original ID.");
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
        clientId, nameOnId: "Link", documentType: "Passport", documentNumber: "TEST000000010",
        issuingJurisdiction: "QC", issuingCountry: "CA", attested: true,
      },
    });
    expect(counter.statusCode, counter.body).toBe(200);
    await dbQuery(handle.db).query("UPDATE branches SET province = NULL WHERE id = $1", [DEMO.branchId]);
    const unknownBare = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId },
    });
    expect(unknownBare.statusCode).toBe(409);
    expect(unknownBare.json().message).toContain("province");
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
      payload: { clientId, choice: "counter_check", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true },
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
    const agreed = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId },
    });
    expect(agreed.statusCode, agreed.body).toBe(200);
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
    const crop = Buffer.from(await decryptSecret(String(row.rows[0]?.face_crop_ciphertext), {
      purpose: PURPOSE_CROP, tenantId: DEMO.tenantId, recordId: String(row.rows[0]?.record_id),
    }, { NODE_ENV: "test" }), "base64");
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
        clientId, nameOnId: "Crop Two", documentType: "Passport", documentNumber: "TEST000000011",
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

  async function postPersona(name: string, inquiryId: string, referenceId: string, eventId: string, env: NodeJS.ProcessEnv, fetchOverride?: typeof fetch) {
    const raw = JSON.stringify({
      data: { id: eventId, attributes: { name, payload: { data: { id: inquiryId, attributes: { status: "approved", "reference-id": referenceId } } } } },
    });
    const { createHmac } = await import("node:crypto");
    const secret = "fixture-webhook-secret";
    const t = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(raw)])).digest("hex");
    const local = await buildApp(handle.db, {}, undefined, {
      env: { PERSONA_API_KEY: "fixture-api-key", PERSONA_WEBHOOK_SECRET: secret, ...env },
      fetch: fetchOverride ?? fetchImpl, sleep: async () => {},
      persona: (await import("../src/idv/providers/persona/index.js")).createPersonaProvider({ PERSONA_WEBHOOK_SECRET: secret }),
    });
    try {
      return await local.inject({
        method: "POST", url: "/api/webhooks/idv/persona", payload: raw,
        headers: { "content-type": "application/json", "persona-signature": `t=${t},v1=${mac}` },
      });
    } finally {
      await local.close();
    }
  }

  async function startedInquiry(clientId: string) {
    const started = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { clientId, tier: "3" },
    });
    expect(started.statusCode, started.body).toBe(200);
    return { inquiryId: started.json().providerRef as string, referenceId: started.json().referenceId as string };
  }

  it("drops the crop when the switch and the consent disagree, and when the check did not pass", async () => {
    const clientId = await client("Switch");
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true } });
    const on = await startedInquiry(clientId);
    expect((await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: on.inquiryId },
    })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: false } });
    expect((await postPersona("inquiry.approved", on.inquiryId, on.referenceId, "evt_on_off", { NODE_ENV: "test" })).statusCode).toBe(200);
    const dropped = await dbQuery(handle.db).query("SELECT face_crop_ciphertext FROM idv_check_records WHERE persona_inquiry_id = $1", [on.inquiryId]);
    expect(dropped.rows[0]?.face_crop_ciphertext).toBeNull();

    const off = await startedInquiry(clientId);
    expect((await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: false, inquiryId: off.inquiryId },
    })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true } });
    expect((await postPersona("inquiry.approved", off.inquiryId, off.referenceId, "evt_off_on", { NODE_ENV: "test" })).statusCode).toBe(200);
    const later = await dbQuery(handle.db).query("SELECT face_crop_ciphertext FROM idv_check_records WHERE persona_inquiry_id = $1", [off.inquiryId]);
    expect(later.rows[0]?.face_crop_ciphertext).toBeNull();

    const declined = await startedInquiry(clientId);
    expect((await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: declined.inquiryId },
    })).statusCode).toBe(200);
    expect((await postPersona("inquiry.declined", declined.inquiryId, declined.referenceId, "evt_declined", { NODE_ENV: "test" })).statusCode).toBe(200);
    const refused = await dbQuery(handle.db).query("SELECT result, face_crop_ciphertext FROM idv_check_records WHERE persona_inquiry_id = $1", [declined.inquiryId]);
    expect(refused.rows[0]?.result).toBe("declined");
    expect(refused.rows[0]?.face_crop_ciphertext).toBeNull();
  });

  it("never passes an expired ID, on the counter or from the webhook", async () => {
    const clientId = await client("Expired");
    const counter = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Expired", documentType: "Passport", documentNumber: NUMBER,
        issuingJurisdiction: "ON", issuingCountry: "CA", expiryDate: "2000-01-02", attested: true,
      },
    });
    expect(counter.statusCode, counter.body).toBe(200);
    const stored = await dbQuery(handle.db).query("SELECT result, attestation, expiry_date FROM idv_check_records WHERE record_id = $1", [counter.json().recordId]);
    expect(stored.rows[0]?.result).toBe("expired");
    expect(String(stored.rows[0]?.attestation ?? "")).not.toContain("not expired");
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(read.json().records[0].line).toBe("Expired 2 Jan 2000");
    expect(read.json().records[0].statusLine).toBe("Expired 2 Jan 2000");
    inquiryExpiry = "2000-01-02";
    const remote = await startedInquiry(clientId);
    expect((await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: remote.inquiryId },
    })).statusCode).toBe(200);
    expect((await postPersona("inquiry.approved", remote.inquiryId, remote.referenceId, "evt_expired", { NODE_ENV: "test" })).statusCode).toBe(200);
    inquiryExpiry = "2030-01-02";
    const row = await dbQuery(handle.db).query("SELECT result, face_crop_ciphertext FROM idv_check_records WHERE persona_inquiry_id = $1", [remote.inquiryId]);
    expect(row.rows[0]?.result).toBe("expired");
    expect(row.rows[0]?.face_crop_ciphertext).toBeNull();
    const again = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(again.json().records[0].statusLine).toBe("Expired 2 Jan 2000");
  });

  it("hides a crop after face_crop_retained_until", async () => {
    const clientId = await client("Oldcrop");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         face_crop_ciphertext, face_crop_retained_until)
       VALUES ('idc_old_crop',$1,$2,$3,$4,'3','id_and_selfie','pass','m.costa','aes-256-gcm$old', now() - interval '1 day')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(read.json().records[0].photoOnFile).toBe(false);
    const view = await app.inject({
      method: "POST", url: "/api/idv/checks/idc_old_crop/face", cookies: cookies.teller,
      payload: { reason: "eye_comparison" },
    });
    expect(view.statusCode).toBe(404);
    expect(view.json().message).toBe("No photo on file");
    const back = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "no" },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().photoLine).toBe("No photo on file");
  });

  it("reads a returning client from the original check, not as a new one", async () => {
    const clientId = await client("Confirmed");
    for (const [id, key] of [["snp_sema", "ca-sema"], ["snp_un", "un-sc"], ["snp_cc", "ca-cc"]] as const) {
      await dbQuery(handle.db).query(
        `INSERT INTO sanctions_list_snapshots
          (snapshot_id, source_key, source_url, fetched_at, last_checked_at, content_sha256, entry_count, status)
         VALUES ($1,$2,'https://example.test/list', now(), now(), $1, 1, 'good')
         ON CONFLICT (snapshot_id) DO NOTHING`,
        [id, key],
      );
    }
    await dbQuery(handle.db).query(
      `INSERT INTO sanctions_list_entries (snapshot_id, entry_key, names, dobs)
       VALUES ('snp_sema','zz','["Xyzzy Plugh"]','[]') ON CONFLICT DO NOTHING`,
    );
    await dbQuery(handle.db).query(
      `INSERT INTO sanctions_score_settings (legal_entity_id, score_threshold, signed_off)
       VALUES ($1, 0.92, true)
       ON CONFLICT (legal_entity_id) DO UPDATE SET signed_off = true`,
      [DEMO.legalEntityId],
    );
    const made = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Confirmed", documentType: "Passport", documentNumber: "TEST000000012",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    expect(made.statusCode, made.body).toBe(200);
    const used = await app.inject({
      method: "POST", url: "/api/idv/checks/returning", cookies: cookies.teller,
      payload: { clientId, noDoubts: true, detailsChanged: false, pepAnswer: "no" },
    });
    expect(used.statusCode, used.body).toBe(200);
    expect(used.json().result).toBe("returning_confirmed");
    const read = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    const original = read.json().records.find((row: { method: string }) => row.method === "in_person");
    const again = read.json().records.find((row: { method: string }) => row.method === "returning_client");
    expect(again.line).toBe(`Returning client, ID checked ${original.verifiedDate}, photo ID, in person`);
    expect(again.statusLine).toBe(again.line);
    expect(again.line.startsWith("ID checked")).toBe(false);
  });

  it("refuses a consent or a link for an inquiry that is not this client's", async () => {
    const ownerClient = await client("Ownerinq");
    const otherClient = await client("Otherinq");
    const owned = await startedInquiry(ownerClient);
    const crossed = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId: otherClient, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: owned.inquiryId },
    });
    expect(crossed.statusCode).toBe(404);
    await dbQuery(handle.db).query(
      "INSERT INTO branches (id, tenant_id, legal_entity_id, name, province) VALUES ('br-other','tnt-other','le-other','Other','ON') ON CONFLICT DO NOTHING",
    );
    await dbQuery(handle.db).query(
      `INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id)
       VALUES ('ref_other_shop','le-other','br-other','o.owner','persona','inq_other_shop','cli_other')
       ON CONFLICT DO NOTHING`,
    );
    const foreign = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId: ownerClient, choice: "agreed", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: "inq_other_shop" },
    });
    expect(foreign.statusCode).toBe(404);
    const link = await app.inject({
      method: "POST", url: "/api/idv/inquiries/inq_other_shop/one-time-link", cookies: cookies.teller, payload: {},
    });
    expect(link.statusCode).toBe(404);
  });

  it("stores a sandbox result with no number when the key is missing, and does not fetch a duplicate", async () => {
    const clientId = await client("Nokey");
    const started = await startedInquiry(clientId);
    const before = seen.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env = { NODE_ENV: "development", PERSONA_API_BASE: "http://127.0.0.1:9" };
      const hook = await postPersona("inquiry.approved", started.inquiryId, started.referenceId, "evt_nokey", env);
      expect(hook.statusCode, hook.body).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(NUMBER);
    } finally {
      warn.mockRestore();
    }
    const row = await dbQuery(handle.db).query(
      "SELECT document_number_ciphertext, face_crop_ciphertext, number_unavailable, document_number_last4 FROM idv_check_records WHERE persona_inquiry_id = $1",
      [started.inquiryId],
    );
    expect(row.rows[0]?.document_number_ciphertext).toBeNull();
    expect(row.rows[0]?.face_crop_ciphertext).toBeNull();
    expect(row.rows[0]?.document_number_last4).toBeNull();
    expect(row.rows[0]?.number_unavailable).toBe(true);
    expect(JSON.stringify(row.rows[0])).not.toContain(NUMBER);
    const file = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(file.statusCode, file.body).toBe(200);
    const personaLine = file.json().records[0].statusLine as string;
    expect(personaLine).toContain("ID verified, scan and selfie");
    expect(personaLine).not.toBe("Missing ID");
    const status = await dbQuery(handle.db).query("SELECT status FROM idv_inquiries WHERE provider_ref = $1", [started.inquiryId]);
    expect(status.rows[0]?.status).not.toBe("in progress");
    expect(status.rows[0]?.status).not.toBe("starting");
    const after = seen.length;
    const again = await postPersona("inquiry.approved", started.inquiryId, started.referenceId, "evt_nokey", {
      NODE_ENV: "development", PERSONA_API_BASE: "http://127.0.0.1:9",
    });
    expect(again.json().duplicate).toBe(true);
    expect(seen.length).toBe(after);
    expect(after).toBeGreaterThan(before);
  });

  it("refuses an early delete, allows one after retain_until, and clears only an expired crop", async () => {
    const clientId = await client("Retain");
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, retain_until)
       VALUES ('idc_keep',$1,$2,$3,$4,'1','in_person','pass','m.costa', now() + interval '5 years')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    await expect(dbQuery(handle.db).query("DELETE FROM idv_check_records WHERE record_id = 'idc_keep'")).rejects.toThrow(/append-only/);
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, retain_until)
       VALUES ('idc_drop',$1,$2,$3,$4,'1','in_person','pass','m.costa', now() - interval '1 day')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    await dbQuery(handle.db).query("DELETE FROM idv_check_records WHERE record_id = 'idc_drop'");
    const gone = await dbQuery(handle.db).query("SELECT 1 FROM idv_check_records WHERE record_id = 'idc_drop'");
    expect(gone.rows.length).toBe(0);
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         face_crop_ciphertext, face_crop_retained_until)
       VALUES ('idc_crop_old',$1,$2,$3,$4,'3','id_and_selfie','pass','m.costa','aes-256-gcm$old', now() - interval '1 day')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    await dbQuery(handle.db).query(
      "UPDATE idv_check_records SET face_crop_ciphertext = NULL, face_crop_retained_until = NULL WHERE record_id = 'idc_crop_old'",
    );
    await dbQuery(handle.db).query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         face_crop_ciphertext, face_crop_retained_until)
       VALUES ('idc_crop_new',$1,$2,$3,$4,'3','id_and_selfie','pass','m.costa','aes-256-gcm$new', now() + interval '5 years')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    await expect(dbQuery(handle.db).query(
      "UPDATE idv_check_records SET face_crop_ciphertext = NULL, face_crop_retained_until = NULL WHERE record_id = 'idc_crop_new'",
    )).rejects.toThrow(/append-only/);
    await expect(dbQuery(handle.db).query("TRUNCATE idv_check_records")).rejects.toThrow(/append-only/);
  });

  it("requires a session, keeps another shop out, and only supersedes for someone else", async () => {
    const clientId = await client("Guard");
    const open = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks` });
    expect(open.statusCode).toBe(401);
    const made = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Guard", documentType: "Passport", documentNumber: "TEST000000013",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    const second = await app.inject({
      method: "POST", url: "/api/idv/checks/in-person", cookies: cookies.teller,
      payload: {
        clientId, nameOnId: "Guard Two", documentType: "Passport", documentNumber: "TEST000000014",
        issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
      },
    });
    const own = await app.inject({
      method: "POST", url: `/api/idv/checks/${made.json().recordId}/supersede`, cookies: cookies.teller,
      payload: { replacedByRecordId: second.json().recordId },
    });
    expect(own.statusCode).toBe(403);
    await dbQuery(handle.db).query(
      `INSERT INTO staff_users (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, password_hash)
       SELECT 'tnt-other:o.owner', 'tnt-other', 'le-other', 'br-other', 'o.owner', 'Other', 'administrator', password_hash
         FROM staff_users WHERE staff_id = 'j.masri' LIMIT 1
       ON CONFLICT DO NOTHING`,
    );
    const otherLogin = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { staffId: "o.owner", password: DEMO.password, tenantId: "tnt-other" },
    });
    expect(otherLogin.statusCode, otherLogin.body).toBe(200);
    const otherCookie = { cdos_session: otherLogin.cookies.find((item) => item.name === "cdos_session")!.value };
    const reveal = await app.inject({
      method: "POST", url: `/api/idv/checks/${made.json().recordId}/reveal`, cookies: otherCookie,
      payload: { reason: "id_mismatch" },
    });
    expect(reveal.statusCode).toBe(404);
    const foreign = await app.inject({
      method: "POST", url: `/api/idv/checks/${made.json().recordId}/supersede`, cookies: otherCookie,
      payload: { replacedByRecordId: second.json().recordId },
    });
    expect(foreign.statusCode).toBe(404);
    const allowed = await app.inject({
      method: "POST", url: `/api/idv/checks/${made.json().recordId}/supersede`, cookies: cookies.owner,
      payload: { replacedByRecordId: second.json().recordId },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const deal = await app.inject({
      method: "POST", url: `/api/idv/checks/${second.json().recordId}/deal`, cookies: cookies.teller,
      payload: { dealId: "deal-missing" },
    });
    expect(deal.statusCode).toBe(404);
    const policy = await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner,
      payload: { privacyPolicyUrl: "http://example.com/privacy" },
    });
    expect(policy.statusCode).toBe(400);
  });

  async function plantInquiry(clientId: string, ref: string) {
    await dbQuery(handle.db).query(
      `INSERT INTO idv_inquiries
        (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, status, requested_tier)
       VALUES ($1,$2,$3,'m.costa','persona',$1,$4,'starting','3')`,
      [ref, DEMO.legalEntityId, DEMO.branchId, clientId],
    );
    return { inquiryId: ref, referenceId: ref };
  }

  it("retries a failed inquiry fetch, and two deliveries write one record", async () => {
    const clientId = await client("Retry");
    const started = await plantInquiry(clientId, "inq_retry_manual");
    let failed = false;
    const flaky: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!failed && url.includes("/inquiries/")) {
        failed = true;
        return new Response("down", { status: 503 });
      }
      return fetchImpl(input, init);
    };
    const env = { NODE_ENV: "test" };
    const first = await postPersona("inquiry.approved", started.inquiryId, started.referenceId, "evt_retry", env, flaky);
    expect(first.statusCode).toBe(500);
    const pending = await dbQuery(handle.db).query("SELECT 1 FROM idv_events WHERE event_id = 'evt_retry'");
    expect(pending.rows.length).toBe(0);
    const missing = await dbQuery(handle.db).query("SELECT 1 FROM idv_check_records WHERE persona_inquiry_id = $1", [started.inquiryId]);
    expect(missing.rows.length).toBe(0);
    const second = await postPersona("inquiry.approved", started.inquiryId, started.referenceId, "evt_retry", env, flaky);
    expect(second.statusCode, second.body).toBe(200);
    const written = await dbQuery(handle.db).query("SELECT 1 FROM idv_check_records WHERE persona_inquiry_id = $1", [started.inquiryId]);
    expect(written.rows.length).toBe(1);

    const other = await client("Race");
    const race = await plantInquiry(other, "inq_race_manual");
    const [left, right] = await Promise.all([
      postPersona("inquiry.approved", race.inquiryId, race.referenceId, "evt_race", env),
      postPersona("inquiry.approved", race.inquiryId, race.referenceId, "evt_race", env),
    ]);
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    const flags = [left.json().duplicate, right.json().duplicate].sort();
    expect(flags).toEqual([false, true]);
    const once = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_check_records WHERE persona_inquiry_id = $1", [race.inquiryId]);
    expect(once.rows[0]?.n).toBe(1);
    const events = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_events WHERE event_id = 'evt_race'");
    expect(events.rows[0]?.n).toBe(1);
  });

  it("keeps no crop when the consent was declined", async () => {
    const clientId = await client("Declinedconsent");
    await app.inject({ method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { faceCropEnabled: true } });
    const started = await plantInquiry(clientId, "inq_declined_consent");
    const consent = await app.inject({
      method: "POST", url: "/api/idv/consents", cookies: cookies.teller,
      payload: { clientId, choice: "counter_check", language: "en", copyVersion: CONSENT_VERSION, faceCropShown: true, inquiryId: started.inquiryId },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const shown = await dbQuery(handle.db).query("SELECT face_crop_shown, choice FROM idv_consents WHERE consent_id = $1", [consent.json().consentId]);
    expect(shown.rows[0]?.choice).toBe("counter_check");
    expect(shown.rows[0]?.face_crop_shown).toBe(true);
    const hook = await postPersona("inquiry.approved", started.inquiryId, started.referenceId, "evt_declined_consent", { NODE_ENV: "test" });
    expect(hook.statusCode, hook.body).toBe(200);
    const row = await dbQuery(handle.db).query("SELECT face_crop_ciphertext FROM idv_check_records WHERE persona_inquiry_id = $1", [started.inquiryId]);
    expect(row.rows[0]?.face_crop_ciphertext).toBeNull();
  });

  it("lists checks only for a client on this shop, and an empty file has no personal data", async () => {
    const name = "Empty File Person";
    const clientId = await client(name);
    const empty = await app.inject({ method: "GET", url: `/api/idv/clients/${clientId}/checks`, cookies: cookies.teller });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().records).toEqual([]);
    expect(empty.json().headline).toBe("No ID check on file");
    expect(empty.body).not.toContain(name);
    expect(empty.body).not.toContain(NUMBER);
    await dbQuery(handle.db).query(
      "INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name) VALUES ('cli_other_shop','tnt-other','le-other','Other Shop Person') ON CONFLICT DO NOTHING",
    );
    const off = await app.inject({ method: "GET", url: "/api/idv/clients/cli_other_shop/checks", cookies: cookies.teller });
    expect(off.statusCode).toBe(404);
    expect(off.json().error).toBe("not_found");
    expect(off.body).not.toContain("Other Shop Person");
  });

  it("refuses an in-person check with 503 when the number key is not set", async () => {
    const clientId = await client("No Key Person");
    const local = await buildApp(handle.db, {}, undefined, {
      env: { NODE_ENV: "development", RENDER_EXTERNAL_HOSTNAME: "unknown.example" },
      fetch: fetchImpl, sleep: async () => {},
    });
    try {
      const login = await local.inject({
        method: "POST", url: "/api/auth/login",
        payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
      const before = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_check_records WHERE client_id = $1", [clientId]);
      const saved = await local.inject({
        method: "POST", url: "/api/idv/checks/in-person", cookies: cookie,
        payload: {
          clientId, nameOnId: "No Key Person", documentType: "Passport", documentNumber: NUMBER,
          issuingJurisdiction: "ON", issuingCountry: "CA", attested: true,
        },
      });
      expect(saved.statusCode, saved.body).toBe(503);
      expect(saved.json()).toEqual({
        error: "id_number_key_unavailable",
        message: "ID number storage is not set up for this shop yet.",
      });
      expect(saved.body).not.toContain(NUMBER);
      const after = await dbQuery(handle.db).query("SELECT count(*)::int AS n FROM idv_check_records WHERE client_id = $1", [clientId]);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    } finally {
      await local.close();
    }
  });
});
