import type { schema } from "../db/index.js";

type Job = typeof schema.enquiryGrowthJobs.$inferSelect;
type Run = typeof schema.enquiryResearchRuns.$inferSelect & { reviews?: unknown[] };
type Call = typeof schema.enquiryCalls.$inferSelect;

export type GrowthWorkflow = {
  stage: string;
  label: string;
  nextAction: string;
  tone: "blue" | "amber" | "green" | "red" | "purple" | "mute";
  step: number;
};

export function growthWorkflow(input: {
  enquiry: typeof schema.enquiries.$inferSelect;
  jobs: Job[];
  research: Run[];
  calls: Call[];
}): GrowthWorkflow {
  if (input.enquiry.doNotContact) return { stage: "do_not_contact", label: "Do not contact", nextAction: "Respect the contact stop", tone: "red", step: 4 };
  if (input.enquiry.status === "accepted") return { stage: "onboarded", label: "Onboarded", nextAction: "Support the new desk", tone: "green", step: 6 };
  if (input.enquiry.status === "declined") return { stage: "closed", label: "Closed", nextAction: "No further action", tone: "mute", step: 6 };

  const latestCall = input.calls[0];
  if (latestCall?.status === "completed") return { stage: "call_completed", label: "Call complete", nextAction: "Record a decision or follow-up", tone: "green", step: 5 };
  if (latestCall && ["requested", "placing", "placed"].includes(latestCall.status)) return { stage: "call_in_progress", label: "Call in progress", nextAction: "Wait for the transcript and outcome", tone: "amber", step: 5 };

  const complete = input.research.find((run) => run.status === "complete" && run.brief?.identity?.verification === "exact_business_name");
  const legacyComplete = input.research.find((run) => run.status === "complete");
  if (complete && (complete.reviews?.length ?? 0) > 0) return { stage: "ready_to_call", label: "Ready to call", nextAction: "Place the approved contextual call", tone: "green", step: 4 };
  if (complete) return { stage: "brief_ready", label: "Brief ready", nextAction: "Review the sourced brief", tone: "purple", step: 3 };
  if (legacyComplete) return { stage: "research_needs_rerun", label: "Research needs re-run", nextAction: "Collect sources tied to the stated business", tone: "amber", step: 2 };

  const latestJob = input.jobs[0];
  if (latestJob?.status === "running") return { stage: "researching", label: "Researching", nextAction: "Wait for source collection", tone: "amber", step: 2 };
  if (latestJob?.status === "queued") return { stage: "research_queued", label: "Research queued", nextAction: "Research will run automatically", tone: "blue", step: 2 };
  if (latestJob?.status === "failed") return { stage: "research_failed", label: "Research needs attention", nextAction: "Inspect the error and re-run research", tone: "red", step: 2 };
  return { stage: "applied", label: "Applied", nextAction: "Queue lead research", tone: "blue", step: 1 };
}
