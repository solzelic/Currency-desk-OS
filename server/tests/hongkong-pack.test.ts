/* Hong Kong arithmetic, without a database.

   The lines are "at or above", so exactly the line is blocked and one
   cent under is not. A stored 0 or NULL must not turn a check off.
   There is no any-amount identification rule: 0.01 on a live 8000
   remittance line is allowed. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  hkdLeg,
  hongKongIdKind,
  hongKongPurposeRequired,
  identificationBlocks,
} from "../src/ledger/hongkong-pack.js";

const row = (threshold: unknown, comparator: unknown = "gte") => ({ threshold, comparator });

describe("money changing, at or above 120000 HKD", () => {
  it("blocks exactly 120000 and allows 119999.99", () => {
    expect(identificationBlocks(new Decimal("120000"), row("120000.00"), null)).toBe(true);
    expect(identificationBlocks(new Decimal("120000.01"), row("120000.00"), null)).toBe(true);
    expect(identificationBlocks(new Decimal("119999.99"), row("120000"), null)).toBe(false);
  });

  it("uses the money-changing line for a bill, a money order, and a cheque", () => {
    expect(hongKongIdKind("bill_payment")).toBe("fx");
    expect(hongKongIdKind("money_order")).toBe("fx");
    expect(hongKongIdKind("cheque_cashing")).toBe("fx");
    expect(hongKongIdKind("exchange")).toBe("fx");
    for (const kind of ["bill_payment", "money_order", "cheque_cashing"]) {
      expect(hongKongIdKind(kind), kind).toBe("fx");
    }
    expect(identificationBlocks(new Decimal("119999.99"), row("120000"), null)).toBe(false);
    expect(identificationBlocks(new Decimal("120000"), row("120000"), null)).toBe(true);
  });

  it("fails closed when the line is missing, blank, zero, or unreadable", () => {
    const amount = new Decimal("10.00");
    expect(identificationBlocks(amount, null, null)).toBe(true);
    expect(identificationBlocks(amount, row(null), null)).toBe(true);
    expect(identificationBlocks(amount, row(""), null)).toBe(true);
    expect(identificationBlocks(amount, row("0"), null)).toBe(true);
    expect(identificationBlocks(amount, row("0.00"), null)).toBe(true);
    expect(identificationBlocks(amount, row("not-a-number"), null)).toBe(true);
    expect(identificationBlocks(amount, row("-1"), null)).toBe(true);
    expect(identificationBlocks(amount, row("120000", "nope"), null)).toBe(true);
    expect(identificationBlocks(new Decimal("NaN"), row("120000"), null)).toBe(true);
    expect(identificationBlocks(new Decimal("-1"), row("120000"), null)).toBe(true);
  });

  it("lets a desk tighten, and does not let a higher desk line loosen", () => {
    const pack = row("120000");
    expect(identificationBlocks(new Decimal("50000"), pack, new Decimal("50000"))).toBe(true);
    expect(identificationBlocks(new Decimal("49999.99"), pack, new Decimal("50000"))).toBe(false);
    expect(identificationBlocks(new Decimal("119999.99"), pack, new Decimal("200000"))).toBe(false);
    expect(identificationBlocks(new Decimal("120000"), pack, new Decimal("200000"))).toBe(true);
    expect(identificationBlocks(new Decimal("120000"), pack, new Decimal("120000"))).toBe(true);
  });

  it("reads a stored more-than comparator without treating it as at-or-above", () => {
    expect(identificationBlocks(new Decimal("120000"), row("120000", "gt"), null)).toBe(false);
    expect(identificationBlocks(new Decimal("120000.01"), row("120000", "gt"), null)).toBe(true);
  });
});

describe("a wire, a remittance, and a virtual asset transfer, at or above 8000 HKD", () => {
  it("blocks exactly 8000 and allows 7999.99 and 0.01", () => {
    expect(hongKongIdKind("remittance")).toBe("remittance");
    expect(hongKongIdKind("remittance_send")).toBe("remittance");
    expect(hongKongIdKind("remittance_receive")).toBe("remittance");
    expect(hongKongIdKind("eft")).toBe("eft");
    expect(hongKongIdKind("virtual_currency")).toBe("virtual_currency");
    const live = row("8000");
    expect(identificationBlocks(new Decimal("0.01"), live, null)).toBe(false);
    expect(identificationBlocks(new Decimal("7999.99"), live, null)).toBe(false);
    expect(identificationBlocks(new Decimal("8000"), live, null)).toBe(true);
    expect(identificationBlocks(new Decimal("8000.01"), live, null)).toBe(true);
  });

  it("does not let a stored 0 or NULL turn the check off", () => {
    const amount = new Decimal("0.01");
    expect(identificationBlocks(amount, null, null)).toBe(true);
    expect(identificationBlocks(amount, row(null), null)).toBe(true);
    expect(identificationBlocks(amount, row(""), null)).toBe(true);
    expect(identificationBlocks(amount, row("0"), null)).toBe(true);
    expect(identificationBlocks(amount, row("0.00"), null)).toBe(true);
  });

  it("does not let a desk line of 50000 loosen the 8000 line", () => {
    const live = row("8000");
    expect(identificationBlocks(new Decimal("7999.99"), live, new Decimal("50000"))).toBe(false);
    expect(identificationBlocks(new Decimal("8000"), live, new Decimal("50000"))).toBe(true);
    expect(identificationBlocks(new Decimal("1000"), live, new Decimal("1000"))).toBe(true);
    expect(identificationBlocks(new Decimal("999.99"), live, new Decimal("1000"))).toBe(false);
  });
});

describe("one HKD leg, and no hard purpose rule", () => {
  it("does not add both sides, and a cross with no HKD leg is unvalued", () => {
    expect(hkdLeg({
      from: "HKD",
      to: "USD",
      inputAmount: new Decimal("120000"),
      outputAmount: new Decimal("15000"),
    })?.toFixed(2)).toBe("120000.00");
    expect(hkdLeg({
      from: "USD",
      to: "HKD",
      inputAmount: new Decimal("15000"),
      outputAmount: new Decimal("120000"),
    })?.toFixed(2)).toBe("120000.00");
    expect(hkdLeg({
      from: "EUR",
      to: "USD",
      inputAmount: new Decimal("100"),
      outputAmount: new Decimal("110"),
    })).toBeNull();
  });

  it("does not require purpose", () => {
    expect(hongKongPurposeRequired()).toBe(false);
  });
});

describe("the migration inserts and does not move a desk", () => {
  const sql = readFileSync(new URL("../src/db/migrations/040_pack_hk_v1.sql", import.meta.url), "utf8");

  it("is insert-only for pack data", () => {
    expect(sql).toMatch(/ON CONFLICT \(pack_id\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(pack_id, deal_kind\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(report_id\) DO NOTHING/);
    expect(sql).not.toMatch(/UPDATE\s+legal_entities/i);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(sql).not.toMatch(/\u2014/);
    expect(sql).not.toMatch(/\u2013/);
  });
});
