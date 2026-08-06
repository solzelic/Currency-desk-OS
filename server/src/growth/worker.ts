import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { researchEnquiry, type LeadResearchProvider } from "./research.js";

type ClaimedJob = typeof schema.enquiryGrowthJobs.$inferSelect;

export async function enqueueResearchJob(input: { db: Db; enquiryId: string; requestedBy: string; now?: Date }): Promise<string> {
  const id = randomUUID();
  const at = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    await tx.insert(schema.enquiryGrowthJobs).values({ id, enquiryId: input.enquiryId, requestedBy: input.requestedBy, availableAt: at, createdAt: at, updatedAt: at });
    await tx.insert(schema.enquiryGrowthEvents).values({
      id: randomUUID(), enquiryId: input.enquiryId, type: "research_queued", detail: { jobId: id }, actor: input.requestedBy, createdAt: at,
    });
  });
  return id;
}

async function claim(db: Db, now: Date): Promise<ClaimedJob | null> {
  const result = await db.execute(sql<ClaimedJob>`
    WITH candidate AS (
      SELECT id FROM enquiry_growth_jobs
      WHERE status = 'queued' AND available_at <= ${now}
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE enquiry_growth_jobs AS job
    SET status = 'running', attempts = attempts + 1, locked_at = ${now}, updated_at = ${now}
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING
      job.id,
      job.enquiry_id AS "enquiryId",
      job.status,
      job.attempts,
      job.max_attempts AS "maxAttempts",
      job.available_at AS "availableAt",
      job.locked_at AS "lockedAt",
      job.completed_at AS "completedAt",
      job.research_id AS "researchId",
      job.error,
      job.requested_by AS "requestedBy",
      job.created_at AS "createdAt",
      job.updated_at AS "updatedAt"
  `);
  return (result.rows?.[0] as ClaimedJob | undefined) ?? null;
}

export async function runResearchWorkerOnce(input: { db: Db; provider: LeadResearchProvider; now?: () => Date }): Promise<string | null> {
  const now = input.now?.() ?? new Date();
  const job = await claim(input.db, now);
  if (!job) return null;
  await input.db.insert(schema.enquiryGrowthEvents).values({
    id: randomUUID(), enquiryId: job.enquiryId, type: "research_started", detail: { jobId: job.id, attempt: job.attempts }, actor: "research-worker", createdAt: now,
  });
  const enquiry = (await input.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, job.enquiryId)).limit(1))[0];
  if (!enquiry) {
    await input.db.update(schema.enquiryGrowthJobs).set({ status: "failed", error: "Application no longer exists.", completedAt: now, updatedAt: now }).where(eq(schema.enquiryGrowthJobs.id, job.id));
    return job.id;
  }
  try {
    const runId = await researchEnquiry({ db: input.db, enquiry, createdBy: job.requestedBy, provider: input.provider, now: input.now });
    await input.db.transaction(async (tx) => {
      await tx.update(schema.enquiryGrowthJobs).set({ status: "completed", researchId: runId, completedAt: input.now?.() ?? new Date(), updatedAt: input.now?.() ?? new Date() }).where(eq(schema.enquiryGrowthJobs.id, job.id));
      await tx.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: job.enquiryId, type: "research_completed", detail: { jobId: job.id, runId }, actor: "research-worker" });
    });
  } catch (error) {
    const exhausted = job.attempts >= job.maxAttempts;
    const message = error instanceof Error ? error.message.slice(0, 2000) : "Research failed.";
    const retryAt = new Date(now.getTime() + Math.min(30, 2 ** job.attempts) * 60_000);
    await input.db.transaction(async (tx) => {
      await tx.update(schema.enquiryGrowthJobs).set({
        status: exhausted ? "failed" : "queued", error: message, availableAt: retryAt,
        completedAt: exhausted ? now : null, lockedAt: null, updatedAt: now,
      }).where(eq(schema.enquiryGrowthJobs.id, job.id));
      await tx.insert(schema.enquiryGrowthEvents).values({
        id: randomUUID(), enquiryId: job.enquiryId, type: exhausted ? "research_failed" : "research_retry_scheduled",
        detail: { jobId: job.id, attempt: job.attempts, error: message }, actor: "research-worker", createdAt: now,
      });
    });
  }
  return job.id;
}

export function startResearchWorker(input: { db: Db; provider: LeadResearchProvider; now?: () => Date; intervalMs?: number }): () => void {
  let active = false;
  const run = async () => {
    if (active) return;
    active = true;
    try {
      while (await runResearchWorkerOnce(input)) { /* drain the durable queue */ }
    } finally { active = false; }
  };
  const staleBefore = new Date((input.now?.() ?? new Date()).getTime() - 10 * 60_000);
  void input.db.update(schema.enquiryGrowthJobs).set({ status: "queued", lockedAt: null, updatedAt: input.now?.() ?? new Date() })
    .where(and(eq(schema.enquiryGrowthJobs.status, "running"), lte(schema.enquiryGrowthJobs.lockedAt, staleBefore)))
    .then(() => run());
  const timer = setInterval(() => void run(), input.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
