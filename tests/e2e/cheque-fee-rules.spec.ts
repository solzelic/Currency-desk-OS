/* The desk's cheque rules, called the way the screen calls them.
   Asia/Tokyo is the break: a hold built with toISOString of a local
   midnight lands on the previous day. The half cent is the other:
   1,000.25 at 2% is 20.01, and a float times toFixed says 20.00. */
import { test, expect } from "./fixtures";

test.use({ timezoneId: "Asia/Tokyo" });

test("the fee rounds half up, the hold stays on the calendar, and a refusal is a sentence", async ({ page }) => {
  await page.goto("/app");
  await page.waitForFunction(
    () => !!(window.CDOS && window.CDOS._cheques && window.CDOS._cheques.feeFor && window.CDOS._cheques.historyTime),
  );
  const result = await page.evaluate(() => {
    localStorage.setItem("cdos_settings", JSON.stringify({ timezone: "America/Toronto" }));
    const rules = window.CDOS._cheques;
    return {
      fee: rules.feeFor(1000.25, { feePct: 2, feeMin: 5 }),
      hold: rules.addDays("2026-10-12", 1),
      shifted: new Date("2026-10-13T00:00:00").toISOString().slice(0, 10),
      time: rules.historyTime("2026-10-12T08:20:00.000Z"),
      sentence: rules.deskSentence("Missing transaction:reverse."),
    };
  });
  expect(result.shifted).not.toBe("2026-10-13");
  expect(result.fee).toBe(20.01);
  expect(result.hold).toBe("2026-10-13");
  expect(result.time).toBe("4:20 am");
  expect(result.sentence).toBe("You cannot reverse this cheque. Ask a supervisor.");
  expect(result.sentence).not.toMatch(/Missing/);
});
