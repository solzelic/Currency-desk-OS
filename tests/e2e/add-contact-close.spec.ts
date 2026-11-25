/* Add contact closes when the file is created, not after the list
   reload. The old priced verify step is gone. Digits typed while the
   PIN pad is the top layer never reach a field behind it. */
import { test, expect, signInAtDesk } from "./fixtures";

test("add contact closes on create and the PIN pad keeps digits off the field behind it", async ({ page }) => {
  let created = false;
  await page.route("**/api/clients", async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname !== "/api/clients") {
      await route.continue();
      return;
    }
    if (req.method() === "POST") {
      created = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          clientId: "cli_fast_add",
          legalName: "Ada Fast",
          kind: "individual",
          aliases: [],
          documents: [],
        }),
      });
      return;
    }
    if (req.method() === "GET" && created) {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clients: [] }),
      });
      return;
    }
    if (req.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ clients: [] }),
      });
      return;
    }
    await route.continue();
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const listed = page.waitForResponse((res) => res.request().method() === "GET" && new URL(res.url()).pathname === "/api/clients");
  await page.locator('[data-app="clients"]').click();
  expect((await listed).status()).toBe(200);
  await page.getByRole("button", { name: "New contact" }).click();
  const modal = page.getByTestId("add-contact");
  await expect(modal).toBeVisible();
  await expect(modal).not.toContainText("$");
  await page.getByRole("button", { name: "Skip. Add the ID later" }).click();
  await page.getByPlaceholder("Jane Doe").fill("Ada Fast");
  await expect(modal).not.toContainText("$");
  const posted = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/clients");
  await page.getByTestId("add-contact-save").click();
  expect((await posted).status()).toBe(201);
  await expect(modal).toBeHidden({ timeout: 1000 });

  await page.evaluate(() => {
    const host = document.createElement("div");
    const input = document.createElement("input");
    input.id = "digit-field";
    host.appendChild(input);
    document.body.appendChild(host);
    const pad = document.createElement("div");
    document.body.appendChild(pad);
    ReactDOM.createRoot(pad).render(React.createElement(window.CDOS.PinPrompt, {
      name: "Ada",
      title: "Enter your PIN",
      onCancel: () => {},
    }));
  });
  const field = page.locator("#digit-field");
  await expect(page.locator("[data-pin-pad=open]")).toBeVisible();
  await field.fill("void reason");
  await field.focus();
  await page.keyboard.type("1948");
  await page.keyboard.press("Backspace");
  await expect(field).toHaveValue("void reason");
});
