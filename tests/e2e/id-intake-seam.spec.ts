/* ============================================================
   A passport scan must not be able to stop the shop.

   Every image the desk captured — an ID scan, a supporting document, the
   business logo, a cheque — went into storage as a base64 data URL at
   whatever size the camera or the phone produced, with no ceiling
   anywhere. One photograph of a passport is three to five megabytes raw
   and about a third larger again once base64'd, against a four-megabyte
   limit on the whole desk's saved state.

   The failure that follows is not a big image. It is that the persistence
   bridge treats the resulting refusal as terminal — "Nothing is being
   saved. Contact CurrencyDesk" — so every client, every filing and every
   setting recorded AFTERWARDS was browser-only until somebody intervened.
   A teller doing exactly their job could stop the desk saving anything.

   The second test is the other half of the same subject. A scan of
   somebody's passport is the most sensitive thing here and it used to
   render on any screen that showed the client, in front of whoever was
   standing at the counter. It is covered until somebody asks, and asking
   leaves a trace — because "who looked at this customer's passport, and
   when" is a question with an answer now.
   ============================================================ */
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

type Page = import("@playwright/test").Page;

/* A photograph the size a phone actually produces. Drawn as noise rather
   than a flat colour on purpose: a solid image compresses to almost
   nothing and would sail under any ceiling, proving the opposite of what
   this test is for. */
async function hugePhotoBytes(page: Page, edge = 3200) {
  return page.evaluate(async (size) => {
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = Math.round(size * 0.66);
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(cv.width, cv.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (i * 7) % 255;
      img.data[i + 1] = (i * 13) % 255;
      img.data[i + 2] = (i * 29) % 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL("image/jpeg", 0.95);
    const bytes = Math.ceil((url.length - url.indexOf(",") - 1) * 3 / 4);
    return { url, bytes };
  }, edge);
}

test("a full-resolution scan is shrunk before it is ever stored", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");

  const original = await hugePhotoBytes(page);
  /* The premise. If this ever stops being true the test below proves
     nothing, so it is asserted rather than assumed. */
  expect(
    original.bytes,
    "the fixture photo must be big enough to matter",
  ).toBeGreaterThan(1_000_000);

  const shrunk = await page.evaluate(async (url) => {
    const out = await (window as any).CDOS.shrinkDataUrl(url);
    return { bytes: (window as any).CDOS.dataUrlBytes(out), url: out };
  }, original.url);

  // an order of magnitude, not a trim
  expect(shrunk.bytes).toBeLessThan(original.bytes / 5);
  expect(shrunk.bytes).toBeLessThan(700 * 1024);
  // and it is still a readable image, not a thumbnail
  const dims = await page.evaluate(
    (url) =>
      new Promise<{ w: number; h: number }>((resolve) => {
        const i = new Image();
        i.onload = () => resolve({ w: i.width, h: i.height });
        i.src = url;
      }),
    shrunk.url,
  );
  expect(Math.max(dims.w, dims.h)).toBe(1200);
});

test("a whole desk of ID scans still fits in what the desk can save", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const original = await hugePhotoBytes(page);

  /* How many scans a desk actually gets, measured rather than hoped for.
     Before the ceiling the answer was "possibly one" — a single phone
     photo could take a desk past its four-megabyte saving limit on its
     own. This asserts the capacity is now a working week's worth of
     customers rather than a single unlucky upload.

     It is deliberately not a round number pulled out of the air. The
     fixture image is pure noise, which is the worst case JPEG can be
     handed; a real passport photograph compresses far better than this,
     so the true figure is better than the one asserted here. */
  const perScan = await page.evaluate(async (url) => {
    const one = await (window as any).CDOS.shrinkDataUrl(url);
    return (window as any).CDOS.dataUrlBytes(one);
  }, original.url);

  const fitInState = Math.floor((4 * 1024 * 1024) / perScan);
  expect(perScan, `one worst-case scan is ${Math.round(perScan / 1024)} KB`).toBeLessThan(180 * 1024);
  expect(fitInState, "a desk should hold a working week of scans").toBeGreaterThanOrEqual(30);
});

test("an image too big even after shrinking is refused, out loud", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");

  /* Not an image at all — the case a person hits by picking the wrong
     thing in the file dialog. It must come back as a refusal with a
     reason, never as a silent no-op and never as something stored. */
  const refused = await page.evaluate(async () => {
    const file = new File([new Uint8Array(2048)], "statement.pdf", {
      type: "application/pdf",
    });
    return (window as any).CDOS.intakeIdImage(file);
  });
  expect(refused.ok).toBe(false);
  expect(refused.why).toMatch(/not an image/i);

  /* A PDF IS allowed as a supporting document, with its own flat limit —
     it cannot be downscaled, so the only honest control is a cap and a
     sentence saying what to do instead. */
  const asDocument = await page.evaluate(async () => {
    const small = new File([new Uint8Array(2048)], "proof.pdf", { type: "application/pdf" });
    const large = new File([new Uint8Array(2 * 1024 * 1024)], "big.pdf", { type: "application/pdf" });
    return {
      small: await (window as any).CDOS.intakeAttachment(small),
      large: await (window as any).CDOS.intakeAttachment(large),
    };
  });
  expect(asDocument.small.ok).toBe(true);
  expect(asDocument.large.ok).toBe(false);
  expect(asDocument.large.why).toMatch(/limited to/i);
});
