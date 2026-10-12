#!/usr/bin/env node
/* Read-only audit for identity values the old desk generator wrote.

   The generator hashed a name into a date of birth, a street address
   and an ID number, then saved them as if a document had been read.
   It is gone. Rows it already wrote are not rewritten here.

   Usage (do not point this at a database you are not allowed to read):

     DATABASE_URL=postgres://… node scripts/audit-synthetic-kyc.mjs

   Output is a client id and the matched field name. A document match
   also prints that document's id. A second list is the client ids
   stored as verified, and the client ids whose screening outcome is
   set. The outcome value is not printed. The name, the date, the
   address and the ID number are not printed. The session is
   read-only. Nothing in this file changes a row. Cleaning a match
   up needs the owner's OK.
*/
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const STREETS = [
  "Bathurst St",
  "Dundas St W",
  "Bloor St E",
  "Eglinton Ave",
  "Lakeshore Blvd",
  "Yonge St",
  "King St W",
  "Queen St E",
];
const CITIES = [
  ["Toronto", "ON", "M5V 2T6"],
  ["Mississauga", "ON", "L5B 4M1"],
  ["Markham", "ON", "L3R 0B8"],
  ["Vaughan", "ON", "L4K 3N1"],
  ["Brampton", "ON", "L6Y 1M5"],
];
const ID_TYPES = ["Driver's Licence", "Passport", "Provincial ID"];

/* The removed generator, byte for byte in its arithmetic. A match is
   this value for this name, not "any Toronto address". */
export function syntheticIdentity(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const pick = (arr) => arr[h % arr.length];
  const num = 100 + (h % 8900);
  const idType = pick(ID_TYPES);
  const idNum = idType === "Passport"
    ? "P" + String(1000000 + (h % 8999999))
    : "DL " + String(1000 + (h % 8999)) + "-" + String(100 + (h % 899));
  const yr = 1972 + (h % 32);
  const mo = 1 + (h % 12);
  const da = 1 + (h % 27);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    address: `${num} ${pick(STREETS)}`,
    dob: `${yr}-${pad(mo)}-${pad(da)}`,
    idNum,
  };
}

/* `client` is { clientId, displayName, dateOfBirth, addressLine,
   aliases: string[], documents: { documentId, number }[] }.
   The result names fields. It does not carry the values. */
export function syntheticMatches(client) {
  const names = [];
  if (client.displayName) names.push(client.displayName);
  for (const alias of client.aliases || []) {
    if (alias && !names.includes(alias)) names.push(alias);
  }
  const fields = [];
  const documentIds = [];
  const seenDocs = new Set();
  let dob = false;
  let address = false;
  for (const name of names) {
    const gen = syntheticIdentity(name);
    if (!dob && client.dateOfBirth && client.dateOfBirth === gen.dob) {
      dob = true;
      fields.push("date_of_birth");
    }
    if (!address && client.addressLine && client.addressLine === gen.address) {
      address = true;
      fields.push("address_line");
    }
    for (const doc of client.documents || []) {
      if (!doc || !doc.number || !doc.documentId || doc.number !== gen.idNum || seenDocs.has(doc.documentId)) continue;
      seenDocs.add(doc.documentId);
      documentIds.push(doc.documentId);
    }
  }
  return { fields, documentIds };
}

/* One line per match. Ids and field names only. */
export function auditLines(clients) {
  const lines = [];
  for (const client of clients) {
    const hit = syntheticMatches(client);
    for (const field of hit.fields) lines.push(`${client.clientId}\t${field}`);
    for (const documentId of hit.documentIds) lines.push(`${client.clientId}\tdoc_number\t${documentId}`);
  }
  return lines;
}

/* Client ids whose stored standing says verified, or whose screening
   outcome is set. The outcome value is not printed. The row is not
   changed. The desk does not read this word as a label. */
export function storedStandingLines(clients) {
  const lines = [];
  for (const client of clients) {
    if (client.verificationStatus === "verified") lines.push(`${client.clientId}\tverification_status`);
    if (client.screeningOutcome != null && client.screeningOutcome !== "") {
      lines.push(`${client.clientId}\tscreening_outcome`);
    }
  }
  return lines;
}

/* Distinct clients, not output lines. One client can match both
   a stored verified standing and a screening outcome. */
export function storedVerifiedCount(lines) {
  const ids = new Set();
  for (const line of lines) ids.add(String(line).split("\t")[0]);
  return ids.size;
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Set DATABASE_URL. This script reads client ids and matched field names. It does not print personal data and it does not change any row.");
    process.exitCode = 1;
    return;
  }
  const require = createRequire(fileURLToPath(new URL("../server/package.json", import.meta.url)));
  const pg = require("pg");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: "-c default_transaction_read_only=on",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const people = await client.query(
      `SELECT client_id, display_name, date_of_birth::text AS date_of_birth, address_line,
              verification_status, screening_outcome
         FROM desk_clients`,
    );
    const aliases = await client.query(
      `SELECT client_id, alias FROM desk_client_aliases`,
    );
    const documents = await client.query(
      `SELECT document_id, client_id, doc_number FROM desk_client_identity_documents`,
    );
    await client.query("ROLLBACK");

    const byId = new Map();
    for (const row of people.rows) {
      byId.set(row.client_id, {
        clientId: row.client_id,
        displayName: row.display_name,
        dateOfBirth: row.date_of_birth,
        addressLine: row.address_line,
        aliases: [],
        documents: [],
        verificationStatus: row.verification_status,
        screeningOutcome: row.screening_outcome,
      });
    }
    for (const row of aliases.rows) {
      const person = byId.get(row.client_id);
      if (person) person.aliases.push(row.alias);
    }
    for (const row of documents.rows) {
      const person = byId.get(row.client_id);
      if (person) person.documents.push({ documentId: row.document_id, number: row.doc_number });
    }
    const peopleRows = [...byId.values()];
    const lines = auditLines(peopleRows);
    const standing = storedStandingLines(peopleRows);
    process.stdout.write(`matches\t${lines.length}\n`);
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    process.stdout.write(`stored_verified\t${storedVerifiedCount(standing)}\n`);
    if (standing.length) process.stdout.write(`${standing.join("\n")}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Audit failed.");
    process.exitCode = 1;
  });
}
