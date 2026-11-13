import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import "../os-src/staging-banner.js";

const shell = readFileSync(new URL("../os-src/cdos-os.jsx", import.meta.url), "utf8");
const effect = shell.match(/const id = 'cdos-staging-banner';[\s\S]*?(?=\n    }, \[stagingOn, stagingDoor, stage, bannerHidden)/)?.[0];
assert.ok(effect, "staging notice effect must be found in the OS source");

function fixture({ rootId = "os", visible = true, cssVisibility = "visible", excluded = false, focused = true, deskLocked = false, handover = false, pinGate = null, tabIndex = null } = {}) {
  const writes = [];
  const focusCalls = [];
  const attributes = new Map(tabIndex === null ? [] : [["tabindex", tabIndex]]);
  const other = {};
  const button = {};
  const banner = { toggleAttribute() {}, querySelector: () => button, offsetHeight: 40 };
  const document = {
    activeElement: focused ? button : other,
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      if (id === "cdos-staging-banner") return banner;
      return id === rootId ? screen : null;
    },
    documentElement: { style: { setProperty() {} } },
  };
  const screen = {
    closest: () => excluded ? screen : null,
    getClientRects: () => visible ? [{}] : [],
    hasAttribute: (key) => attributes.has(key),
    setAttribute: (key, value) => attributes.set(key, value),
    focus: (options) => {
      assert.equal(writes.includes("hidden"), false, "move focus before hiding the notice");
      focusCalls.push({ preventScroll: options.preventScroll });
      document.activeElement = screen;
    },
  };
  const scope = {
    window: { CDOS: globalThis.CDOS, getComputedStyle: () => ({ visibility: cssVisibility }) },
    document,
    stagingOn: true,
    stagingDoor: false,
    stage: rootId === "lock" ? "lock" : "desktop",
    bannerHidden: false,
    deskLocked,
    handover,
    pinGate,
    bannerStore: () => ({ setItem: (key, value) => writes.push([key, value]) }),
    setBannerHidden: (hidden) => {
      assert.equal(hidden, true);
      writes.push("hidden");
    },
  };
  runInNewContext(`(() => { ${effect} })()`, scope);
  return { button, document, screen, other, focusCalls, writes, attributes };
}

for (const rootId of ["lock", "os"]) {
  test(`focused dismissal moves focus to the visible #${rootId} without scrolling`, () => {
    const { button, document, screen, focusCalls, writes, attributes } = fixture({ rootId });
    button.onclick();
    assert.equal(document.activeElement, screen);
    assert.deepEqual(focusCalls, [{ preventScroll: true }]);
    assert.equal(attributes.get("tabindex"), "-1");
    assert.equal(writes[0][0], "cdos.stagingBanner.hiddenAt");
    assert.equal(writes[1], "hidden");
    button.onclick();
    assert.equal(focusCalls.length, 1);
  });
}

test("dismissal does not steal focus from another control", () => {
  const { button, document, other, focusCalls, writes } = fixture({ focused: false });
  button.onclick();
  assert.equal(document.activeElement, other);
  assert.equal(focusCalls.length, 0);
  assert.equal(writes.at(-1), "hidden");
});

for (const settings of [{ rootId: null }, { visible: false }, { cssVisibility: "hidden" }, { excluded: true }, { deskLocked: true }, { handover: true }, { pinGate: {} }]) {
  test(`dismissal does not focus a missing or unavailable screen (${JSON.stringify(settings)})`, () => {
    const { button, focusCalls, writes } = fixture(settings);
    button.onclick();
    assert.equal(focusCalls.length, 0);
    assert.equal(writes.at(-1), "hidden");
  });
}

test("dismissal preserves an existing screen tabindex", () => {
  const { button, attributes, focusCalls } = fixture({ tabIndex: "0" });
  button.onclick();
  assert.equal(attributes.get("tabindex"), "0");
  assert.equal(focusCalls.length, 1);
});
