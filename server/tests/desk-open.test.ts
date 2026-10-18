/* A new desk is one that has not saved cdos_settings. The cheque
   schedule, and a tour flag beside it, are not a finished desk.
   Loaded from the shipped bridge, not a copy. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCHEDULE = "[{\"id\":\"payroll\",\"feePct\":2}]";
const RATES = "{\"rows\":{\"EUR\":{\"mid\":1.25}}}";

function loadBridge() {
  const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-persist.js"), "utf8");
  const store = new Map<string, string>();
  const localStorage = {
    get length() { return store.size; },
    key(i: number) { return [...store.keys()][i] ?? null; },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, String(v)); },
    removeItem(k: string) { store.delete(k); },
  };
  let body: { state: Record<string, unknown> | null; version: number } = { state: null, version: 0 };
  const win: Record<string, unknown> = {};
  const sandbox = {
    window: win,
    localStorage,
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }), body: { appendChild: () => {} } },
    console,
    fetch: async () => ({ ok: true, status: 200, json: async () => body }),
    Date,
    JSON,
    Object,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));
  const bridge = win.CDOS_PERSIST as { begin: (tid: string) => Promise<string> };
  return {
    begin: (state: Record<string, unknown> | null) => {
      store.clear();
      store.set("yorkfx_rates_v1", RATES);
      body = { state, version: 1 };
      return bridge.begin("tnt-new");
    },
    store,
  };
}

const bridge = loadBridge();

describe("opening a desk", () => {
  it("opens as new when the only stored key is the schedule", async () => {
    expect(await bridge.begin({ cdos_cheque_schedule_v1: SCHEDULE })).toBe("empty");
    expect(bridge.store.get("cdos_cheque_schedule_v1")).toBe(SCHEDULE);
    expect(bridge.store.get("yorkfx_rates_v1")).toBe(RATES);
  });

  it("opens as new when the schedule is stored with the tour key", async () => {
    expect(await bridge.begin({ cdos_cheque_schedule_v1: SCHEDULE, cdos_tour_v1: "{\"seen\":true}" })).toBe("empty");
    expect(bridge.store.get("cdos_cheque_schedule_v1")).toBe(SCHEDULE);
    expect(bridge.store.get("cdos_tour_v1")).toBe("{\"seen\":true}");
    expect(bridge.store.get("yorkfx_rates_v1")).toBe(RATES);
  });

  it("opens as new when the schedule is stored with another key", async () => {
    expect(await bridge.begin({ cdos_cheque_schedule_v1: SCHEDULE, cdos_calc_v1: "1" })).toBe("empty");
    expect(bridge.store.get("cdos_cheque_schedule_v1")).toBe(SCHEDULE);
    expect(bridge.store.get("cdos_calc_v1")).toBe("1");
    expect(bridge.store.get("yorkfx_rates_v1")).toBe(RATES);
  });

  it("opens as restored when cdos_settings is saved", async () => {
    const settings = "{\"bizName\":\"Harbour FX\"}";
    expect(await bridge.begin({ cdos_cheque_schedule_v1: SCHEDULE, cdos_settings: settings })).toBe("restored");
    expect(bridge.store.get("cdos_settings")).toBe(settings);
    expect(bridge.store.get("cdos_cheque_schedule_v1")).toBe(SCHEDULE);
    expect(bridge.store.has("yorkfx_rates_v1")).toBe(false);
  });
});
