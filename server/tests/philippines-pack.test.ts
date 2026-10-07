/* Philippines thresholds, without a database.

   Every line is "more than", so the amount on the line is allowed and
   the next centavo is not. A missing row or a zero row is a different
   question from the live 5,000 line: zero means every deal, and 0.01
   is refused. */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { packForCountry } from "../src/ledger/jurisdiction.js";
import {
  PH_CASH_PAYOUT_PHP,
  PH_CTR_PHP,
  PH_FX_CDD_PHP,
  PH_OCCASIONAL_CDD_PHP,
  PH_SALE_USD,
  identificationBlocks,
  pesoLeg,
  philippinesIdKind,
  philippinesPurposeRequired,
} from "../src/ledger/philippines-pack.js";

const php = (value: string) => new Decimal(value);

describe("which deal reads which line", () => {
  it("keeps cheque cashing off the money-changing line", () => {
    expect(philippinesIdKind("exchange")).toBe("fx");
    expect(philippinesIdKind("remittance_send")).toBe("remittance");
    expect(philippinesIdKind("remittance_receive")).toBe("remittance");
    expect(philippinesIdKind("money_order")).toBe("remittance");
    expect(philippinesIdKind("bill_payment")).toBe("eft");
    expect(philippinesIdKind("eft")).toBe("eft");
    expect(philippinesIdKind("virtual_currency")).toBe("virtual_currency");
    expect(philippinesIdKind("cheque_cashing")).toBe("eft");
  });

  it("opens a Philippines desk on the Philippines pack, in pesos", () => {
    expect(packForCountry("PH")).toEqual({
      packId: "pack-ph-v1",
      version: 1,
      homeCurrency: "PHP",
    });
    expect(packForCountry("Philippines")?.packId).toBe("pack-ph-v1");
    expect(packForCountry("Republic of the Philippines")?.homeCurrency).toBe("PHP");
  });
});

describe("identification, including a zero or a missing row", () => {
  const row = (threshold: unknown, comparator: unknown = "gt") => ({ threshold, comparator });

  it("refuses a 0.01 transfer when the threshold is zero", () => {
    expect(identificationBlocks(php("0.01"), row("0"), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row("0.00", "gte"), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row(0), null)).toBe(true);
  });

  it("refuses a 0.01 transfer when the threshold is missing", () => {
    expect(identificationBlocks(php("0.01"), null, null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row(null), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row(""), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row("not-a-number"), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row("-1"), null)).toBe(true);
    expect(identificationBlocks(php("0.01"), row("5000", "approx"), null)).toBe(true);
  });

  it("allows a 1.00 remittance on the live 5,000 line, and blocks the next centavo", () => {
    const live = row(PH_FX_CDD_PHP.toFixed(2));
    expect(identificationBlocks(php("1.00"), live, null)).toBe(false);
    expect(identificationBlocks(php("4999.99"), live, null)).toBe(false);
    expect(identificationBlocks(php("5000.00"), live, null)).toBe(false);
    expect(identificationBlocks(php("5000.01"), live, null)).toBe(true);
  });

  it("uses more than 100,000 for a cheque, a bill, and virtual currency", () => {
    const live = row(PH_OCCASIONAL_CDD_PHP.toFixed(2));
    expect(identificationBlocks(php("100000.00"), live, null)).toBe(false);
    expect(identificationBlocks(php("100000.01"), live, null)).toBe(true);
    expect(identificationBlocks(php("5000.01"), live, null)).toBe(false);
  });

  it("lets a desk tighten and does not let a desk loosen", () => {
    const live = row("5000.00");
    expect(identificationBlocks(php("1000.00"), live, php("1000"))).toBe(true);
    expect(identificationBlocks(php("999.99"), live, php("1000"))).toBe(false);
    expect(identificationBlocks(php("5000.00"), live, php("8000"))).toBe(false);
    expect(identificationBlocks(php("5000.01"), live, php("8000"))).toBe(true);
    expect(identificationBlocks(php("0.01"), row("0.00"), php("1000"))).toBe(true);
  });
});

describe("one deal, not a sum", () => {
  it("flags a covered transaction only above 500,000", () => {
    expect(philippinesPurposeRequired(php("500000.00"))).toBe(false);
    expect(philippinesPurposeRequired(php("500000.01"))).toBe(true);
    expect(PH_CTR_PHP.eq("500000")).toBe(true);
    expect(PH_CASH_PAYOUT_PHP.eq(PH_CTR_PHP)).toBe(true);
    expect(PH_SALE_USD.eq("10000")).toBe(true);
  });

  it("reads one peso leg and does not add the two sides", () => {
    expect(
      pesoLeg({
        from: "PHP",
        to: "USD",
        inputAmount: php("500000.00"),
        outputAmount: php("9000"),
      })?.eq("500000"),
    ).toBe(true);
    expect(
      pesoLeg({
        from: "USD",
        to: "PHP",
        inputAmount: php("9000"),
        outputAmount: php("500000.01"),
      })?.eq("500000.01"),
    ).toBe(true);
    expect(
      pesoLeg({
        from: "EUR",
        to: "USD",
        inputAmount: php("100"),
        outputAmount: php("110"),
      }),
    ).toBeNull();
  });
});
