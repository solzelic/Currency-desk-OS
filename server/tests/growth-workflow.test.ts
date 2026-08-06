import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runResearchWorkerOnce } from "../src/growth/worker.js";
import type { LeadResearchProvider } from "../src/growth/research.js";
import { seed } from "../src/seed.js";

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string> = {};

const research = vi.fn(async () => ({
  summary: "North Star FX presents itself as a Toronto currency exchange. FINTRAC registration was not confirmed.",
  brief: {
    executiveSummary: "North Star FX presents itself as a Toronto currency exchange. FINTRAC registration was not confirmed.",
    sourceCount: 1, registryStatus: "not_confirmed" as const,
    talkingPoints: [], openQuestions: [],
    identity: { businessName: "North Star FX", websiteHost: "northstar.example", verification: "exact_business_name" as const },
  },
  facts: [{
    key: "website_profile_1",
    value: "Currency exchange services in Toronto.",
    sourceUrl: "https://northstar.example/about",
    confidence: 0.82,
    method: "website_read" as const,
  }],
  creditsUsed: 2,
  costCents: 4,
}));

const provider: LeadResearchProvider = { name: "fixture", model: "fixture-v2", research };

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db, { researchProvider: provider, autoResearch: false });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
  const cookie = login.cookies.find((item) => item.name === "cdos_session");
  admin = cookie ? { cdos_session: cookie.value } : {};
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("automatic growth workflow", () => {
  it("commits a queued job with an application and does not research in the public request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/enquiries",
      payload: {
        kind: "early_access",
        email: "queued@northstar.example",
        name: "Mira Chen",
        details: { shopName: "North Star FX", website: "northstar.example", phone: "+14165550191" },
        contactContext: { timezone: "America/Toronto" },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(research).not.toHaveBeenCalled();

    const enquiry = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "queued@northstar.example")))[0]!;
    const jobs = await handle.db.select().from(schema.enquiryGrowthJobs).where(eq(schema.enquiryGrowthJobs.enquiryId, enquiry.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "queued", requestedBy: "system" });

    const claimed = await Promise.all([
      runResearchWorkerOnce({ db: handle.db, provider }),
      runResearchWorkerOnce({ db: handle.db, provider }),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(research).toHaveBeenCalledTimes(1);

    const view = await app.inject({ method: "GET", url: `/api/admin/enquiries/${enquiry.id}/growth`, cookies: admin });
    expect(view.statusCode).toBe(200);
    expect(view.json().workflow).toMatchObject({ stage: "brief_ready", nextAction: "Review the sourced brief" });
    expect(view.json().research[0].brief).toMatchObject({ sourceCount: 1 });
    expect(view.json().timeline.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      "application_received", "research_queued", "research_started", "research_completed",
    ]));
  });

  it("shows ownership and operational stage in the team pipeline", async () => {
    const enquiry = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "queued@northstar.example")))[0]!;
    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/admin/enquiries/${enquiry.id}/growth/assignment`,
      cookies: admin,
      payload: { assignedTo: "j.masri" },
    });
    expect(assigned.statusCode).toBe(200);

    const pipeline = await app.inject({ method: "GET", url: "/api/admin/growth/pipeline", cookies: admin });
    expect(pipeline.statusCode).toBe(200);
    expect(pipeline.json().byEnquiry[enquiry.id]).toMatchObject({
      workflow: { stage: "brief_ready" },
      assignment: { assignedTo: "j.masri" },
    });
    expect(pipeline.json().counts.brief_ready).toBeGreaterThanOrEqual(1);
  });
});
