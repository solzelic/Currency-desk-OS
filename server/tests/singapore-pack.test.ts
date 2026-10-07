/* Singapore arithmetic, without a database.

   The lines are "more than", so exactly the line is allowed and one
   cent over is not. A cross-border money transfer does not read the
   stored cell. NULL and 0 must not turn a check off. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  crossBorderMoneyTransfer,
  identificationBlocks,
  sgdLeg,
  singaporeIdentificationRequired,
  singaporePurposeRequired,
} from "../src/ledger/singapore-pack.js";

const row = (threshold: unknown, comparator: unknown = "gt") => ({ threshold, comparator });

describe("money changing, more than 5000 SGD", () => {
  it("allows exactly 5000 and blocks 5000.01", () => {
    expect(identificationBlocks("exchange", new Decimal("5000"), row("5000.00"), null)).toBe(false);
    expect(identificationBlocks("exchange", new Decimal("5000.01"), row("5000.00"), null)).toBe(true);
    expect(identificationBlocks("fx", new Decimal("4999.99"), row("5000"), null)).toBe(false);
  });

  it("uses the same line for a domestic transfer, a bill, and a money order", () => {
    for (const kind of ["eft", "bill_payment", "money_order"]) {
      expect(identificationBlocks(kind, new Decimal("5000"), row("5000"), null), kind).toBe(false);
      expect(identificationBlocks(kind, new Decimal("5000.01"), row("5000"), null), kind).toBe(true);
    }
    expect(crossBorderMoneyTransfer("money_order")).toBe(false);
  });

  it("fails closed when the line is missing, blank, zero, or unreadable", () => {
    const amount = new Decimal("10.00");
    expect(identificationBlocks("exchange", amount, null, null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row(null), null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row(""), null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row("0"), null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row("0.00"), null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row("not-a-number"), null)).toBe(true);
    expect(identificationBlocks("exchange", amount, row("5000", "nope"), null)).toBe(true);
    expect(identificationBlocks("exchange", new Decimal("NaN"), row("5000"), null)).toBe(true);
    expect(identificationBlocks("exchange", new Decimal("-1"), row("5000"), null)).toBe(true);
  });

  it("lets a desk tighten, and does not let a higher desk line loosen", () => {
    const pack = row("5000");
    expect(identificationBlocks("exchange", new Decimal("1000"), pack, new Decimal("1000"))).toBe(true);
    expect(identificationBlocks("exchange", new Decimal("999.99"), pack, new Decimal("1000"))).toBe(false);
    expect(identificationBlocks("exchange", new Decimal("5000"), pack, new Decimal("8000"))).toBe(false);
    expect(identificationBlocks("exchange", new Decimal("5000.01"), pack, new Decimal("8000"))).toBe(true);
  });
});

describe("a cross-border money transfer is every deal", () => {
  it("blocks 0.01 and 0.00 no matter what the stored cell says", () => {
    for (const kind of ["remittance", "remittance_send", "remittance_receive"]) {
      expect(crossBorderMoneyTransfer(kind), kind).toBe(true);
      for (const stored of [null, row(null), row(""), row("0"), row("0.00"), row("5000"), row("5000", "gte")]) {
        expect(identificationBlocks(kind, new Decimal("0.01"), stored, null), kind).toBe(true);
        expect(identificationBlocks(kind, new Decimal("0.00"), stored, null), kind).toBe(true);
      }
      expect(identificationBlocks(kind, new Decimal("0.01"), row("5000"), new Decimal("10000"))).toBe(true);
    }
  });
});

describe("kinds the Notice does not put on a line", () => {
  it("does not block cheque cashing", () => {
    expect(identificationBlocks("cheque_cashing", new Decimal("5000.01"), row("5000"), null)).toBe(false);
    expect(identificationBlocks("cheque_cashing", new Decimal("9000"), null, null)).toBe(false);
    expect(identificationBlocks("cheque_cashing", new Decimal("-1"), null, null)).toBe(true);
  });

  it("does not invent a virtual-currency line, and still fails closed if a row is stored", () => {
    expect(identificationBlocks("virtual_currency", new Decimal("5000.01"), null, null)).toBe(false);
    expect(identificationBlocks("virtual_currency", new Decimal("0.01"), row(null), null)).toBe(true);
    expect(identificationBlocks("virtual_currency", new Decimal("0.01"), row("0"), null)).toBe(true);
    expect(identificationBlocks("virtual_currency", new Decimal("100"), row("5000"), null)).toBe(false);
    expect(identificationBlocks("virtual_currency", new Decimal("5000.01"), row("5000"), null)).toBe(true);
  });
});

describe("one SGD leg, and no hard purpose rule", () => {
  it("does not add both sides, and a cross with no SGD leg is unvalued", () => {
    expect(sgdLeg({
      from: "SGD",
      to: "USD",
      inputAmount: new Decimal("5000"),
      outputAmount: new Decimal("3700"),
    })?.toFixed(2)).toBe("5000.00");
    expect(sgdLeg({
      from: "USD",
      to: "SGD",
      inputAmount: new Decimal("3700"),
      outputAmount: new Decimal("5000"),
    })?.toFixed(2)).toBe("5000.00");
    expect(sgdLeg({
      from: "EUR",
      to: "USD",
      inputAmount: new Decimal("100"),
      outputAmount: new Decimal("110"),
    })).toBeNull();
  });

  it("does not require purpose", () => {
    expect(singaporePurposeRequired()).toBe(false);
  });

  it("answers the screen from the kind, and does not treat a missing amount as under the line", () => {
    const row = { threshold: "5000.00", comparator: "gt" };
    expect(singaporeIdentificationRequired({
      dealKind: "cheque_cashing", sgd: new Decimal("9000"), row, deskLine: null,
    })).toBe(false);
    expect(singaporeIdentificationRequired({
      dealKind: "remittance_send", sgd: null, row: null, deskLine: null,
    })).toBe(true);
    expect(singaporeIdentificationRequired({
      dealKind: "fx", sgd: null, row, deskLine: null,
    })).toBe(true);
    expect(singaporeIdentificationRequired({
      dealKind: "fx", sgd: new Decimal("5000.00"), row, deskLine: null,
    })).toBe(false);
    expect(singaporeIdentificationRequired({
      dealKind: "fx", sgd: new Decimal("5000.01"), row, deskLine: null,
    })).toBe(true);
  });
});

describe("the migration inserts and does not move a desk", () => {
  const sql = readFileSync(new URL("../src/db/migrations/039_pack_sg_v1.sql", import.meta.url), "utf8");

  it("is insert-only for pack data", () => {
    expect(sql).toMatch(/ON CONFLICT \(pack_id\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(pack_id, deal_kind\) DO NOTHING/);
    expect(sql).toMatch(/ON CONFLICT \(report_id\) DO NOTHING/);
    expect(sql).not.toMatch(/UPDATE\s+legal_entities/i);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+NOT\s+NULL/i);
  });
});
