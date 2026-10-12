/* The old generator's exact values, and the promise that an audit of
   them prints an id and a field name and nothing a person could be
   found by. No database: the script's session is read-only, and this
   does not open one. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { auditLines, storedStandingLines, storedVerifiedCount, syntheticIdentity } from "../scripts/audit-synthetic-kyc.mjs";

const script = fileURLToPath(new URL("../scripts/audit-synthetic-kyc.mjs", import.meta.url));

/* Fixed from the removed generator. The fixtures below are these
   literals. They are not built by calling the generator, so a changed
   hash cannot invent a matching expected value. */
const WEI_ZHANG = {
  address: "6379 Queen St E",
  dob: "1979-12-27",
  idNum: "DL 2149-622",
};
const ANA_COSTA_DOB = "1980-01-04";

test("pins the old generator for Wei Zhang to one literal", () => {
  assert.deepEqual(syntheticIdentity("Wei Zhang"), WEI_ZHANG);
});

test("flags a generated date, address or ID number by field name only", () => {
  const name = "Wei Zhang";
  const former = "Ana Costa";
  const lines = auditLines([
    {
      clientId: "cli_match",
      displayName: name,
      dateOfBirth: WEI_ZHANG.dob,
      addressLine: WEI_ZHANG.address,
      aliases: [],
      documents: [{ documentId: "doc_match", number: WEI_ZHANG.idNum }],
    },
    {
      clientId: "cli_renamed",
      displayName: "A Different Person",
      dateOfBirth: ANA_COSTA_DOB,
      addressLine: "14 Elm Street",
      aliases: [former],
      documents: [],
    },
    {
      clientId: "cli_real",
      displayName: name,
      dateOfBirth: "1981-06-15",
      addressLine: "14 Elm Street",
      aliases: [],
      documents: [{ documentId: "doc_real", number: "PA-11223" }],
    },
  ]);
  const text = lines.join("\n");
  assert.deepEqual(lines, [
    "cli_match\tdate_of_birth",
    "cli_match\taddress_line",
    "cli_match\tdoc_number\tdoc_match",
    "cli_renamed\tdate_of_birth",
  ]);
  for (const secret of [name, former, WEI_ZHANG.dob, WEI_ZHANG.address, WEI_ZHANG.idNum, ANA_COSTA_DOB, "14 Elm Street", "PA-11223", "A Different Person"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("lists client ids stored as verified, and not the screening value", () => {
  const lines = storedStandingLines([
    { clientId: "cli_verified", verificationStatus: "verified", screeningOutcome: null },
    { clientId: "cli_screened", verificationStatus: "identified", screeningOutcome: "clear" },
    { clientId: "cli_plain", verificationStatus: "identified", screeningOutcome: null },
    { clientId: "cli_blank", verificationStatus: "unverified", screeningOutcome: "" },
  ]);
  assert.deepEqual(lines, [
    "cli_verified\tverification_status",
    "cli_screened\tscreening_outcome",
  ]);
  assert.equal(lines.join("\n").includes("clear"), false);
  assert.equal(storedVerifiedCount(lines), 2);
});

test("counts a client once when verified and screened", () => {
  const lines = storedStandingLines([
    { clientId: "cli_both", verificationStatus: "verified", screeningOutcome: "clear" },
    { clientId: "cli_screen", verificationStatus: "unverified", screeningOutcome: "hit" },
  ]);
  assert.equal(lines.length, 3);
  assert.equal(storedVerifiedCount(lines), 2);
  const text = lines.join("\n");
  assert.equal(text.includes("clear"), false);
  assert.equal(text.includes("hit"), false);
});

test("is a read-only script and refuses to start without DATABASE_URL", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /default_transaction_read_only=on/);
  assert.doesNotMatch(source, /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/);

  const env = { ...process.env };
  delete env.DATABASE_URL;
  const run = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(`${run.stdout}${run.stderr}`, /DATABASE_URL/);
  assert.equal(String(run.stdout).includes("postgres://"), false);
});
