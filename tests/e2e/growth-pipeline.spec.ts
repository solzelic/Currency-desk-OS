/* The browser seam for the provenance boundary: applicant-stated answers and
   inferred research must render as visibly different records. Provider calls
   are covered at the server boundary; this test owns the join to admin.html. */
import { test, expect, rendered, signInAsOperator } from "./fixtures";

test("the application page separates stated answers from sourced research", async ({ page }) => {
  await signInAsOperator(page);
  const stamp = Date.now();
  const email = `growth-${stamp}@example.test`;
  const id = await page.evaluate(async ({ email }) => {
    const applied = await fetch("/api/enquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "early_access",
        email,
        name: "Growth Test Lead",
        details: { shopName: "Test FX", phone: "+14165550177", monthlyVolume: "$10M+" },
        contactContext: { timezone: "America/Toronto" },
      }),
    });
    if (!applied.ok) throw new Error(`application failed: ${applied.status}`);
    const listed = await fetch("/api/admin/enquiries?kind=early_access").then((response) => response.json());
    return listed.enquiries.find((row: { email: string }) => row.email === email).id as string;
  }, { email });

  await page.route(`**/api/admin/enquiries/${id}/growth`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      research: [{
        id: "research-browser-fixture",
        runAt: "2026-08-06T15:00:00.000Z",
        provider: "fixture",
        status: "complete",
        summary: "Public registry evidence is available below.",
        brief: {
          executiveSummary: "Test FX has one possible FINTRAC name match. Staff must verify it before calling.",
          sourceCount: 1,
          registryStatus: "possible_match",
          talkingPoints: ["Confirm the business model and locations."],
          openQuestions: ["Confirm the registry record belongs to this applicant."],
          identity: { businessName: "Test FX", websiteHost: null, verification: "exact_business_name" },
        },
        costCents: 3,
        reviews: [],
        facts: [{
          id: "fact-browser-fixture",
          key: "fintrac_registration",
          value: "The public registry lists registration M123456.",
          sourceUrl: "https://registry.example/msb/M123456",
          confidence: 0.98,
          method: "registry",
        }],
      }],
      calls: [],
      consent: { consentedAt: "2026-08-06T14:00:00.000Z", formVersion: "early-access-2026-08-06", timezone: "America/Toronto", timezoneSource: "browser" },
      doNotContact: false,
      jobs: [], timeline: [], assignment: null,
      assignableMembers: [{ email: "j.masri", name: "J. Masri", role: "owner" }],
      workflow: { stage: "brief_ready", label: "Brief ready", nextAction: "Review the sourced brief", tone: "purple", step: 3 },
      capabilities: { researchConfigured: true, callingConfigured: true, callingEnabled: false, canManageCalling: true, canWrite: true },
    }),
  }));

  await page.goto(`/admin#/applications/${id}`);
  await page.reload();
  await rendered(page, "What research inferred");

  const stated = page.getByTestId("applicant-stated");
  const inferred = page.getByTestId("research-inferred");
  await expect(stated).toContainText("$10M+");
  await expect(inferred).toContainText("The public registry lists registration M123456.");
  await expect(inferred).not.toContainText("$10M+");
  await expect(inferred.getByRole("link", { name: /registry\.example/ })).toHaveAttribute("href", "https://registry.example/msb/M123456");
  await expect(inferred).toContainText("names stated business");
  await expect(inferred.getByTestId("growth-workflow")).toContainText("Brief ready");
  await expect(inferred.getByTestId("research-brief")).toContainText("possible FINTRAC name match");
  await expect(inferred.getByRole("button", { name: "Call now with AI" })).toBeDisabled();
});
