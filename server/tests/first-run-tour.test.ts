/* The first-run tour.

   Who is walked through what, and the fact that skip and finish are
   remembered, are decided in os-src/cdos-tour.js. Tested here, out of
   that file, for the same reason the persistence merge is: a copy of
   the logic in the test would stay green after the real one changed.

   The screen itself is the shell. What this file can prove without a
   browser is the part that would otherwise only fail in front of a
   person: the two tours are different paths, a step whose screen is
   not available is not offered, and a skip or a finish is still a skip
   or a finish when the preference is read back — which is what a
   refresh does.
*/
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describe as describeState } from "../src/state/shape.js";

interface Step {
  id: string;
  tour: string;
  app: string;
  anchor: string;
  reveal?: string;
  needsClient?: boolean;
  title: string;
  body: string;
}

interface TourApi {
  KEY: string;
  kindForRole: (role: string) => string;
  stepsFor: (opts: { role?: string; apps?: string[] | null; hasClient?: boolean }) => Step[];
  clientForTour: (clients: Record<string, { docs?: unknown[] }> | null) => string | null;
  hasClient: (clients: Record<string, unknown> | null) => boolean;
  dropUnplaced: (steps: Step[], missing: string[]) => Step[];
  shouldShow: (book: Record<string, { status?: string }>, id: string | null) => boolean;
  record: (storage: Memory, id: string, status: string, tour: string, now?: string) => Record<string, { status: string; tour: string }>;
  read: (storage: Memory) => Record<string, { status?: string; tour?: string }>;
}

interface Memory {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function loadTour(): TourApi {
  const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-tour.js"), "utf8");
  const win: Record<string, unknown> = {};
  const sandbox = { window: win };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));
  return win.CDOS_TOUR as TourApi;
}

function memory(): Memory {
  const box = new Map<string, string>();
  return {
    getItem: (k) => (box.has(k) ? box.get(k)! : null),
    setItem: (k, v) => { box.set(k, String(v)); },
  };
}

const tour = loadTour();
const DOCK = ["dashboard", "clients", "till", "ledger", "rates", "settings"];

const ids = (steps: Step[]) => steps.map((s) => s.id);
const anchors = (steps: Step[]) => steps.map((s) => s.anchor);

describe("who is shown which path", () => {
  const owner = tour.stepsFor({ role: "Owner", apps: DOCK, hasClient: true });
  const employee = tour.stepsFor({ role: "Cashier", apps: DOCK, hasClient: true });

  it("walks an owner through the shop, the clients, and the file folder", () => {
    expect(ids(owner)).toEqual(["shop", "clients", "standing", "folder", "search"]);
    expect(owner.every((s) => s.tour === "owner")).toBe(true);
    expect(anchors(owner)).toEqual(["shop", "clients", "identification", "file-folder", "file-search"]);
  });

  it("walks an employee through the till, not the owner's shop", () => {
    expect(tour.kindForRole("Cashier")).toBe("employee");
    expect(tour.kindForRole("Manager")).toBe("employee");
    expect(tour.kindForRole("Senior teller")).toBe("employee");
    expect(ids(employee)).toEqual(["till", "count", "close"]);
    expect(anchors(employee)).toEqual(["till", "till-count", "till-reconcile"]);
    expect(employee.every((s) => s.app === "till")).toBe(true);
  });

  it("the two tours do not share a step", () => {
    const ownerIds = new Set(ids(owner));
    const shared = ids(employee).filter((id) => ownerIds.has(id));
    expect(shared).toEqual([]);
    const ownerAnchors = new Set(anchors(owner));
    expect(anchors(employee).filter((a) => ownerAnchors.has(a))).toEqual([]);
  });

  it("drops a step whose screen is not on the dock", () => {
    const noTill = tour.stepsFor({ role: "Cashier", apps: ["ledger", "clients"], hasClient: true });
    expect(noTill).toEqual([]);
    const noShop = tour.stepsFor({ role: "Owner", apps: ["clients", "till"], hasClient: true });
    expect(ids(noShop)).not.toContain("shop");
    expect(ids(noShop)).toContain("clients");
  });

  it("drops the file folder when there is no customer to open", () => {
    const steps = tour.stepsFor({ role: "Owner", apps: DOCK, hasClient: false });
    expect(ids(steps)).toEqual(["shop", "clients"]);
  });

  it("drops a step the screen did not render", () => {
    const steps = tour.stepsFor({ role: "Owner", apps: DOCK, hasClient: true });
    const left = tour.dropUnplaced(steps, ["file-search"]);
    expect(ids(left)).toEqual(["shop", "clients", "standing", "folder"]);
    expect(tour.dropUnplaced(steps, ["shop", "clients", "identification", "file-folder", "file-search"])).toEqual([]);
  });
});

describe("which customer the folder opens", () => {
  it("prefers a customer who already has a paper, so search is on the page", () => {
    const name = tour.clientForTour({
      "Ada Lutz": { docs: [] },
      "Ben Cho": { docs: [{ label: "Proof of address" }] },
    });
    expect(name).toBe("Ben Cho");
  });

  it("opens the only customer when nobody has a paper yet", () => {
    expect(tour.clientForTour({ "Ada Lutz": {} })).toBe("Ada Lutz");
    expect(tour.hasClient(null)).toBe(false);
    expect(tour.hasClient({})).toBe(false);
  });
});

describe("skip and finish are remembered", () => {
  it("a skip is still a skip when the preference is read back", () => {
    const store = memory();
    expect(tour.shouldShow(tour.read(store), "a.singh")).toBe(true);
    tour.record(store, "a.singh", "skipped", "employee", "2026-09-30T12:00:00.000Z");
    const again = tour.read(store);
    expect(tour.shouldShow(again, "a.singh")).toBe(false);
    expect(again["a.singh"]).toMatchObject({ status: "skipped", tour: "employee" });
  });

  it("finishing is still finished when the preference is read back", () => {
    const store = memory();
    tour.record(store, "j.masri", "finished", "owner", "2026-09-30T12:00:00.000Z");
    const again = tour.read(store);
    expect(tour.shouldShow(again, "j.masri")).toBe(false);
    expect(again["j.masri"]).toMatchObject({ status: "finished", tour: "owner" });
  });

  it("one person's choice does not dismiss a colleague", () => {
    const store = memory();
    tour.record(store, "j.masri", "finished", "owner");
    tour.record(store, "A.Singh", "skipped", "employee");
    const book = tour.read(store);
    expect(tour.shouldShow(book, "j.masri")).toBe(false);
    expect(tour.shouldShow(book, "a.singh")).toBe(false);
    expect(tour.shouldShow(book, "m.costa")).toBe(true);
    expect(book["j.masri"]?.status).toBe("finished");
    expect(book["a.singh"]?.status).toBe("skipped");
  });

  it("a broken document does not count as a choice", () => {
    const store = memory();
    store.setItem(tour.KEY, "{ not json");
    expect(tour.shouldShow(tour.read(store), "a.singh")).toBe(true);
    store.setItem(tour.KEY, JSON.stringify({ "a.singh": { status: "later" } }));
    expect(tour.shouldShow(tour.read(store), "a.singh")).toBe(true);
  });

  it("is the preference key the desk document already saves", () => {
    expect(tour.KEY).toBe("cdos_tour_v1");
    const stored = JSON.stringify({
      "a.singh": { status: "skipped", tour: "employee", at: "2026-09-30T12:00:00.000Z" },
    });
    const report = describeState({ cdos_tour_v1: stored });
    expect(report.unknown).toEqual([]);
    expect(report.invalid).toEqual([]);
    expect(report.keys.find((k) => k.key === "cdos_tour_v1")?.kind).toBe("preference");
  });
});

describe("the steps point at screens the app actually has", () => {
  const sources = readdirSync(resolve(process.cwd(), "../os-src"))
    .filter((f) => /\.(jsx|js)$/.test(f))
    .map((f) => readFileSync(resolve(process.cwd(), "../os-src", f), "utf8"))
    .join("\n");

  it("every anchor is a data-tour on a real screen", () => {
    const steps = [
      ...tour.stepsFor({ role: "Owner", apps: null, hasClient: true }),
      ...tour.stepsFor({ role: "Cashier", apps: null, hasClient: true }),
    ];
    for (const step of steps) {
      const attr = `data-tour="${step.anchor}"`;
      const dynamic = `'${step.anchor}'`;
      expect(
        sources.includes(attr) || sources.includes(dynamic),
        `${step.id} should mark ${step.anchor} on a screen`,
      ).toBe(true);
      if (step.reveal) {
        expect(sources.includes(`'${step.reveal}'`) || sources.includes(`data-tour="${step.reveal}"`)).toBe(true);
      }
    }
  });

  it("the desk shell loads the tour and mounts it", () => {
    const html = readFileSync(resolve(process.cwd(), "../CurrencyDesk OS.html"), "utf8");
    expect(html).toContain('src="os-src/cdos-tour.js"');
    expect(html).toContain('src="os-src/cdos-tour.jsx"');
    const shell = readFileSync(resolve(process.cwd(), "../os-src/cdos-os.jsx"), "utf8");
    expect(shell).toContain("FirstRun");
    expect(shell).toContain("openClient={openClientProfile}");
  });
});
