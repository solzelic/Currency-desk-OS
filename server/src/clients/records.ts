/* ============================================================
   The desk's customer file, on the server.

   Every one of these operations is scoped to the LEGAL ENTITY, never to
   the branch and never to the till. One shop's customer is that shop's
   customer at every counter it has and at every location it ever opens.
   That is the single decision in this file that decides whether the
   second branch costs an afternoon or a rewrite.

   Authorization still happens at the workspace, through
   `authorizeLedgerActor`, because that is where the principal row lives
   and it is the same gate the ledger uses. So the question asked is "may
   this person, sitting at this till, read customers" and the answer they
   get is "all of this ENTITY's customers" — which is exactly the
   behaviour a shop expects and exactly what the old browser store could
   not do.

   ---- WHAT VIEWING AN IDENTITY DOCUMENT WRITES ----

   `revealDocumentScan` is the only way to get the bytes of a passport
   out of this system, and it writes a `ledger_audit_events` row before
   it returns them, in the same transaction. Not afterwards, not
   best-effort: the read and the record of the read either both happen or
   neither does.

   This is not a permission. Anybody who can open a client file can
   already see the document if they want it, and pretending otherwise
   would be theatre. What it changes is that looking is deliberate and
   leaves a trace — "who looked at this customer's passport, and when" is
   a question a regulator asks, and the answer used to be that nobody
   could say. The audit row follows the pattern in
   ledger/threshold-control.ts, for the same reason: some acts leave no
   other trace anywhere, so the only record that they happened is the one
   written when they happen.

   A client PHOTOGRAPH is not audited the same way. It is a different
   thing with a different purpose — recognising a regular at the counter
   — and treating a face the desk took itself as equivalent to a
   government document would make the ID trail noise. See
   docs/CLIENT_RECORDS.md.
   ============================================================ */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { authorizeLedgerActor } from "../ledger/principal.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";

/* Scope is two columns, and it is two columns on purpose. Compare
   `scope()` in the ledger services, which is five. */
const entityScope = (actor: LedgerActor) => [actor.tenantId, actor.legalEntityId];

export type ClientKind = "individual" | "business";
export type RiskRating = "low" | "normal" | "medium" | "high";
export type VerificationStatus = "unverified" | "identified" | "verified" | "expired";
export type ScreeningOutcome = "clear" | "hit" | "pending";

export type ClientInput = {
  kind?: ClientKind;
  legalName: string;
  dateOfBirth?: string | null;
  addressLine?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  occupation?: string | null;
  notes?: string | null;
  riskRating?: RiskRating;
  verificationStatus?: VerificationStatus;
  screeningOutcome?: ScreeningOutcome | null;
  screeningMatched?: string | null;
  incorporationDate?: string | null;
  incorporationJurisdiction?: string | null;
  natureOfBusiness?: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
};

export type DocumentInput = {
  docType: string;
  docNumber?: string | null;
  issuingJurisdiction?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  isPrimary?: boolean;
  /* A data URL, already through `intakeIdImage` in the browser. Optional
     — a desk that has typed a passport number but not photographed the
     page has still recorded something worth keeping. */
  scanDataUrl?: string | null;
};

/* The columns a caller may set, and what they are called on the row.
   Spelled out rather than derived, so that adding a column to the table
   does not silently make it writable by anybody who can guess its name. */
const CLIENT_COLUMNS = {
  kind: "kind",
  legalName: "display_name",
  dateOfBirth: "date_of_birth",
  addressLine: "address_line",
  city: "city",
  region: "region",
  postalCode: "postal_code",
  country: "country",
  email: "email",
  phone: "phone",
  occupation: "occupation",
  notes: "notes",
  riskRating: "risk_rating",
  verificationStatus: "verification_status",
  screeningOutcome: "screening_outcome",
  screeningMatched: "screening_matched",
  incorporationDate: "incorporation_date",
  incorporationJurisdiction: "incorporation_jurisdiction",
  natureOfBusiness: "nature_of_business",
  contactName: "contact_name",
  contactTitle: "contact_title",
} as const;

type ClientField = keyof typeof CLIENT_COLUMNS;

/* How the desk's word for an identity becomes the ledger's word for it.

   The ledger has four states and the posting gate refuses above the
   identification threshold unless the row says exactly "verified". The
   desk draws a finer distinction the ledger does not have: `identified`
   means papers are on file, `verified` means a provider authenticated
   them, and only the second is KYC in the sense a regulator means.

   Both map to the ledger's "verified" here, and that is deliberate
   rather than sloppy. The desk has always posted deals on the strength
   of papers on file; narrowing it in this change would start refusing
   transactions that cleared yesterday, silently, as a side effect of a
   customer-records migration. Whether the posting gate should require a
   provider verification is a real question and it belongs to the
   compliance path, out loud, not here. */
const LEDGER_ID_STATUS: Readonly<Record<VerificationStatus, string>> = {
  unverified: "missing",
  identified: "verified",
  verified: "verified",
  expired: "expired",
};

const LEDGER_RISK: Readonly<Record<RiskRating, string>> = {
  low: "normal",
  normal: "normal",
  medium: "enhanced",
  high: "high",
};

const nameKey = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/* A data URL in, content type and bytes out. Refuses anything that is
   not one rather than storing a string that will render as a broken
   image three years from now when somebody needs it for an examiner. */
function decodeDataUrl(dataUrl: string): { contentType: string; bytes: Buffer } {
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match)
    throw new LedgerError(
      "SCAN_NOT_AN_IMAGE",
      "A document scan has to arrive as a base64 data URL. Nothing was stored.",
    );
  const contentType = match[1]!.toLowerCase();
  if (!contentType.startsWith("image/") && contentType !== "application/pdf")
    throw new LedgerError(
      "SCAN_NOT_AN_IMAGE",
      "A document scan has to be an image or a PDF. Nothing was stored.",
    );
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length)
    throw new LedgerError("SCAN_NOT_AN_IMAGE", "That scan is empty. Nothing was stored.");
  /* The browser already shrinks every intake to roughly 150 KB
     (`intakeIdImage`). This is the backstop for a caller that did not,
     and it is generous on purpose: refusing a real passport page because
     somebody's phone is unusually good would push the desk back to
     keeping it outside the system, which is the thing being fixed. */
  if (bytes.length > 4 * 1024 * 1024)
    throw new LedgerError(
      "SCAN_TOO_LARGE",
      "That scan is larger than four megabytes. Photograph the document again rather than scanning it at full resolution — nothing was stored.",
    );
  return { contentType, bytes };
}

const asDataUrl = (contentType: string, bytes: Buffer) =>
  `data:${contentType};base64,${bytes.toString("base64")}`;

export class ClientRecordService {
  constructor(private readonly pool: pg.Pool) {}

  private async inTransaction<T>(
    actor: LedgerActor,
    permission: "customer:view" | "customer:write",
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, permission);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Every customer of this legal entity, from any of its counters. */
  async list(actor: LedgerActor) {
    return this.inTransaction(actor, "customer:view", async (client) => {
      const clients = await client.query(
        `SELECT * FROM desk_clients
          WHERE tenant_id=$1 AND legal_entity_id=$2
          ORDER BY display_name, client_id`,
        entityScope(actor),
      );
      if (!clients.rowCount) return { clients: [] };
      const ids = clients.rows.map((row) => row.client_id as string);
      const documents = await client.query(
        `SELECT * FROM desk_client_identity_documents
          WHERE client_id = ANY($1::text[])
          ORDER BY is_primary DESC, created_at`,
        [ids],
      );
      const aliases = await client.query(
        `SELECT * FROM desk_client_aliases
          WHERE client_id = ANY($1::text[]) ORDER BY created_at`,
        [ids],
      );
      /* Which documents have a scan, never the scan. A list screen
         renders forty customers; forty passports on the wire to draw
         forty padlock icons is the shape of leak nobody notices because
         nothing on screen looks wrong. */
      const scans = await client.query(
        `SELECT document_id, count(*)::int AS n FROM desk_client_images
          WHERE client_id = ANY($1::text[]) AND purpose='identity_document'
          GROUP BY document_id`,
        [ids],
      );
      const photographs = await client.query(
        `SELECT DISTINCT ON (client_id) client_id, image_id, captured_at
           FROM desk_client_images
          WHERE client_id = ANY($1::text[]) AND purpose='client_photograph'
          ORDER BY client_id, captured_at DESC`,
        [ids],
      );
      const scanCount = new Map(scans.rows.map((row) => [row.document_id, row.n as number]));
      const photo = new Map(photographs.rows.map((row) => [row.client_id, row]));
      /* Same-name records, surfaced rather than merged. This is the
         entire defect being fixed, said out loud on every read: two
         David Chens come back as two clients, each told about the
         other. */
      const byName = new Map<string, string[]>();
      for (const row of clients.rows) {
        const key = `${row.legal_entity_id}\u0000${row.name_key}`;
        byName.set(key, (byName.get(key) ?? []).concat(row.client_id));
      }
      return {
        clients: clients.rows.map((row) =>
          clientJson(
            row,
            documents.rows.filter((d) => d.client_id === row.client_id),
            aliases.rows.filter((a) => a.client_id === row.client_id),
            scanCount,
            photo.get(row.client_id) ?? null,
            (byName.get(`${row.legal_entity_id}\u0000${row.name_key}`) ?? []).filter(
              (id) => id !== row.client_id,
            ),
          ),
        ),
      };
    });
  }

  /** One customer, with their documents' METADATA. Never with the bytes. */
  async get(actor: LedgerActor, clientId: string) {
    return this.inTransaction(actor, "customer:view", (client) =>
      this.readOne(client, actor, clientId));
  }

  private async readOne(client: pg.PoolClient, actor: LedgerActor, clientId: string) {
    const found = await client.query(
      `SELECT * FROM desk_clients
        WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3`,
      [clientId, ...entityScope(actor)],
    );
    if (!found.rowCount) throw notFound();
    const row = found.rows[0]!;
    const documents = await client.query(
      `SELECT * FROM desk_client_identity_documents
        WHERE client_id=$1 ORDER BY is_primary DESC, created_at`,
      [clientId],
    );
    const aliases = await client.query(
      "SELECT * FROM desk_client_aliases WHERE client_id=$1 ORDER BY created_at",
      [clientId],
    );
    const scans = await client.query(
      `SELECT document_id, count(*)::int AS n FROM desk_client_images
        WHERE client_id=$1 AND purpose='identity_document' GROUP BY document_id`,
      [clientId],
    );
    const photograph = await client.query(
      `SELECT image_id, captured_at, captured_by FROM desk_client_images
        WHERE client_id=$1 AND purpose='client_photograph'
        ORDER BY captured_at DESC LIMIT 1`,
      [clientId],
    );
    const sameName = await client.query(
      `SELECT client_id FROM desk_clients
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND name_key=$3 AND client_id<>$4`,
      [...entityScope(actor), row.name_key, clientId],
    );
    return clientJson(
      row,
      documents.rows,
      aliases.rows,
      new Map(scans.rows.map((s) => [s.document_id, s.n as number])),
      photograph.rows[0] ?? null,
      sameName.rows.map((s) => s.client_id as string),
    );
  }

  /**
   * Open a file on somebody.
   *
   * A name collision is NOT refused. Two people called David Chen are two
   * customers, and a product that will not let the second one exist is
   * the same defect as one that merges them, wearing a warning label. The
   * created record comes back carrying `sameNameClientIds`, and the
   * screen says so where a teller can see it before they carry on.
   */
  async create(actor: LedgerActor, input: ClientInput) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const clientId = `cli_${randomUUID()}`;
      const now = new Date();
      await client.query(
        `INSERT INTO desk_clients
          (client_id,tenant_id,legal_entity_id,display_name,kind,
           date_of_birth,address_line,city,region,postal_code,country,email,phone,
           occupation,notes,risk_rating,verification_status,
           screening_outcome,screening_matched,
           incorporation_date,incorporation_jurisdiction,nature_of_business,
           contact_name,contact_title,
           created_by,updated_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 $20,$21,$22,$23,$24,$25,$25,$26,$26)`,
        [
          clientId,
          ...entityScope(actor),
          input.legalName.trim(),
          input.kind ?? "individual",
          blank(input.dateOfBirth),
          blank(input.addressLine),
          blank(input.city),
          blank(input.region),
          blank(input.postalCode),
          blank(input.country),
          blank(input.email),
          blank(input.phone),
          blank(input.occupation),
          blank(input.notes),
          input.riskRating ?? "normal",
          input.verificationStatus ?? "unverified",
          blank(input.screeningOutcome),
          blank(input.screeningMatched),
          blank(input.incorporationDate),
          blank(input.incorporationJurisdiction),
          blank(input.natureOfBusiness),
          blank(input.contactName),
          blank(input.contactTitle),
          actor.userId,
          now,
        ],
      );
      await this.audit(
        client,
        actor,
        "client.create",
        clientId,
        `${input.kind ?? "individual"} · ${input.legalName.trim()}`,
      );
      await this.syncCounterRecord(client, actor, clientId);
      return this.readOne(client, actor, clientId);
    });
  }

  /**
   * Change the file.
   *
   * A change of NAME is the operation this whole table exists to make
   * safe, and it does two extra things: the previous name is kept as an
   * alias so everything already filed under it still resolves, and the
   * audit row says what it was and what it became. Renaming a customer
   * used to move a key and orphan a history; here it is an UPDATE to one
   * column and nothing else moves at all.
   */
  async update(actor: LedgerActor, clientId: string, changes: Partial<ClientInput>) {
    const entries = Object.entries(changes).filter(
      ([field, value]) => value !== undefined && field in CLIENT_COLUMNS,
    ) as [ClientField, unknown][];
    if (!entries.length)
      throw new LedgerError(
        "INVALID_REQUEST",
        "Nothing to change — name at least one field.",
      );
    return this.inTransaction(actor, "customer:write", async (client) => {
      const before = await client.query(
        `SELECT display_name,risk_rating,verification_status FROM desk_clients
          WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 FOR UPDATE`,
        [clientId, ...entityScope(actor)],
      );
      if (!before.rowCount) throw notFound();
      const previousName = before.rows[0]!.display_name as string;
      const assignments = entries.map(
        ([field], index) => `${CLIENT_COLUMNS[field]}=$${index + 4}`,
      );
      await client.query(
        `UPDATE desk_clients
            SET ${assignments.join(",")}, updated_by=$2, updated_at=$3
          WHERE client_id=$1`,
        [
          clientId,
          actor.userId,
          new Date(),
          ...entries.map(([field, value]) =>
            typeof value === "string" ? blank(value) : (value ?? null),
          ),
        ],
      );
      const renamed =
        typeof changes.legalName === "string" &&
        changes.legalName.trim() !== previousName;
      if (renamed) {
        /* The old name, kept forever. Nothing filed under it is
           orphaned, because a lookup by name still finds this row. */
        await client.query(
          `INSERT INTO desk_client_aliases
            (alias_id,client_id,tenant_id,legal_entity_id,alias,alias_kind,created_by)
           VALUES ($1,$2,$3,$4,$5,'former_name',$6)
           ON CONFLICT (client_id,alias_key,alias_kind) DO NOTHING`,
          [
            `als_${randomUUID()}`,
            clientId,
            ...entityScope(actor),
            previousName,
            actor.userId,
          ],
        );
        await this.audit(
          client,
          actor,
          "client.rename",
          clientId,
          `${previousName} → ${changes.legalName!.trim()} (previous name kept as an alias)`,
        );
      }
      const touched = entries.map(([field]) => field).join(", ");
      await this.audit(client, actor, "client.update", clientId, `changed: ${touched}`);
      await this.syncCounterRecord(client, actor, clientId);
      return this.readOne(client, actor, clientId);
    });
  }

  /** Another name this customer is known by. */
  async addAlias(actor: LedgerActor, clientId: string, alias: string) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const owned = await client.query(
        "SELECT 1 FROM desk_clients WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3",
        [clientId, ...entityScope(actor)],
      );
      if (!owned.rowCount) throw notFound();
      await client.query(
        `INSERT INTO desk_client_aliases
          (alias_id,client_id,tenant_id,legal_entity_id,alias,alias_kind,created_by)
         VALUES ($1,$2,$3,$4,$5,'also_known_as',$6)
         ON CONFLICT (client_id,alias_key,alias_kind) DO NOTHING`,
        [`als_${randomUUID()}`, clientId, ...entityScope(actor), alias.trim(), actor.userId],
      );
      await this.audit(client, actor, "client.alias.add", clientId, alias.trim());
      return this.readOne(client, actor, clientId);
    });
  }

  /**
   * Who is this, given a name?
   *
   * Aliases included, which is the whole point: a transaction, a filing
   * or a report that still carries the name the browser store used
   * resolves through the alias row the migration wrote. A rename never
   * orphans anybody again.
   *
   * More than one answer is a legitimate answer. Two people share a name;
   * this returns both and lets the desk choose, rather than picking one
   * and being quietly wrong about somebody's compliance history.
   */
  async lookupByName(actor: LedgerActor, name: string) {
    const key = nameKey(name);
    return this.inTransaction(actor, "customer:view", async (client) => {
      const matches = await client.query(
        `SELECT DISTINCT c.client_id
           FROM desk_clients c
           LEFT JOIN desk_client_aliases a ON a.client_id = c.client_id
          WHERE c.tenant_id=$1 AND c.legal_entity_id=$2
            AND (c.name_key=$3 OR a.alias_key=$3)`,
        [...entityScope(actor), key],
      );
      const rows = [];
      for (const match of matches.rows) rows.push(await this.readOne(client, actor, match.client_id));
      return { name: name.trim(), clients: rows };
    });
  }

  /* ---- identity documents ------------------------------------------- */

  async addDocument(actor: LedgerActor, clientId: string, input: DocumentInput) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const owned = await client.query(
        "SELECT 1 FROM desk_clients WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 FOR UPDATE",
        [clientId, ...entityScope(actor)],
      );
      if (!owned.rowCount) throw notFound();
      const documentId = `doc_${randomUUID()}`;
      /* Exactly one document drives the desk's KYC standing. The old
         shape let a top-level "primary" ID and an array entry both claim
         it; the unique index refuses, so demote first. */
      const primary = input.isPrimary ?? !(await this.hasPrimary(client, clientId));
      if (primary)
        await client.query(
          "UPDATE desk_client_identity_documents SET is_primary=false WHERE client_id=$1 AND is_primary",
          [clientId],
        );
      await client.query(
        `INSERT INTO desk_client_identity_documents
          (document_id,client_id,tenant_id,legal_entity_id,doc_type,doc_number,
           issuing_jurisdiction,issued_on,expires_on,is_primary,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          documentId,
          clientId,
          ...entityScope(actor),
          input.docType.trim(),
          blank(input.docNumber),
          blank(input.issuingJurisdiction),
          blank(input.issuedOn),
          blank(input.expiresOn),
          primary,
          actor.userId,
        ],
      );
      if (input.scanDataUrl)
        await this.storeImage(client, actor, clientId, "identity_document", input.scanDataUrl, documentId, input.docType.trim());
      /* The audit row names the TYPE and never the number. An audit log
         that quotes passport numbers is a second copy of the thing being
         protected, in a table designed to be read widely and kept
         forever. */
      await this.audit(
        client,
        actor,
        "client.document.add",
        clientId,
        `${input.docType.trim()}${input.scanDataUrl ? " · scan captured" : " · no scan"}`,
      );
      await this.refreshVerification(client, clientId);
      await this.syncCounterRecord(client, actor, clientId);
      return this.readOne(client, actor, clientId);
    });
  }

  async updateDocument(
    actor: LedgerActor,
    clientId: string,
    documentId: string,
    input: Partial<DocumentInput>,
  ) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const found = await client.query(
        `SELECT d.document_id FROM desk_client_identity_documents d
           JOIN desk_clients c ON c.client_id=d.client_id
          WHERE d.document_id=$1 AND d.client_id=$2
            AND c.tenant_id=$3 AND c.legal_entity_id=$4 FOR UPDATE`,
        [documentId, clientId, ...entityScope(actor)],
      );
      if (!found.rowCount) throw documentNotFound();
      const columns: Record<string, unknown> = {};
      if (input.docType !== undefined) columns.doc_type = input.docType.trim();
      if (input.docNumber !== undefined) columns.doc_number = blank(input.docNumber);
      if (input.issuingJurisdiction !== undefined)
        columns.issuing_jurisdiction = blank(input.issuingJurisdiction);
      if (input.issuedOn !== undefined) columns.issued_on = blank(input.issuedOn);
      if (input.expiresOn !== undefined) columns.expires_on = blank(input.expiresOn);
      if (input.isPrimary === true) {
        await client.query(
          "UPDATE desk_client_identity_documents SET is_primary=false WHERE client_id=$1 AND is_primary",
          [clientId],
        );
        columns.is_primary = true;
      }
      const names = Object.keys(columns);
      if (names.length)
        await client.query(
          `UPDATE desk_client_identity_documents
              SET ${names.map((name, i) => `${name}=$${i + 3}`).join(",")},
                  updated_by=$2, updated_at=now()
            WHERE document_id=$1`,
          [documentId, actor.userId, ...names.map((name) => columns[name])],
        );
      if (input.scanDataUrl)
        await this.storeImage(client, actor, clientId, "identity_document", input.scanDataUrl, documentId, input.docType?.trim() ?? null);
      await this.audit(
        client,
        actor,
        "client.document.update",
        clientId,
        `${documentId} · changed: ${names.join(", ") || "scan"}`,
      );
      await this.refreshVerification(client, clientId);
      await this.syncCounterRecord(client, actor, clientId);
      return this.readOne(client, actor, clientId);
    });
  }

  async removeDocument(actor: LedgerActor, clientId: string, documentId: string) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const removed = await client.query(
        `DELETE FROM desk_client_identity_documents d
          USING desk_clients c
          WHERE d.document_id=$1 AND d.client_id=$2 AND c.client_id=d.client_id
            AND c.tenant_id=$3 AND c.legal_entity_id=$4
        RETURNING d.doc_type`,
        [documentId, clientId, ...entityScope(actor)],
      );
      if (!removed.rowCount) throw documentNotFound();
      await this.audit(
        client,
        actor,
        "client.document.remove",
        clientId,
        `${removed.rows[0]!.doc_type} removed`,
      );
      await this.refreshVerification(client, clientId);
      await this.syncCounterRecord(client, actor, clientId);
      return this.readOne(client, actor, clientId);
    });
  }

  /**
   * Take the picture off the file, keeping the document.
   *
   * Its own operation rather than a null written through the document
   * editor, because it is a different act: the desk still holds a
   * passport number and an expiry, it no longer holds the photograph of
   * the page. Audited for the same reason the reveal is — a scan that
   * quietly stopped existing is a record-keeping failure somebody has to
   * be able to date.
   */
  async removeDocumentScan(actor: LedgerActor, clientId: string, documentId: string) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const removed = await client.query(
        `DELETE FROM desk_client_images i
          USING desk_client_identity_documents d, desk_clients c
          WHERE i.document_id=$1 AND d.document_id=i.document_id
            AND c.client_id=d.client_id AND c.client_id=$2
            AND c.tenant_id=$3 AND c.legal_entity_id=$4
        RETURNING d.doc_type`,
        [documentId, clientId, ...entityScope(actor)],
      );
      if (!removed.rowCount)
        throw new LedgerError(
          "SCAN_NOT_ON_FILE",
          "This desk holds no scan of that document, so there is nothing to remove.",
        );
      await this.audit(
        client,
        actor,
        "client.document.scan.remove",
        clientId,
        `${removed.rows[0]!.doc_type} · scan removed, document kept`,
        documentId,
      );
      return this.readOne(client, actor, clientId);
    });
  }

  /**
   * The scan itself — and the record that somebody asked for it.
   *
   * The INSERT into `ledger_audit_events` and the SELECT of the bytes are
   * in one transaction. There is no path that returns a passport without
   * writing the row, because there is no other path to the bytes at all:
   * they are not in the desk's saved state, not in the list response, and
   * not in the record response. Asking is the only way, and asking is
   * recorded.
   *
   * `purpose` is the teller's own words for why they are looking. Free
   * text and optional — a required reason field on a screen somebody uses
   * forty times a day becomes "check" forty times, which is worse than an
   * honest blank.
   */
  async revealDocumentScan(
    actor: LedgerActor,
    clientId: string,
    documentId: string,
    purpose?: string,
  ) {
    return this.inTransaction(actor, "customer:view", async (client) => {
      const found = await client.query(
        `SELECT d.doc_type, c.display_name, i.image_id, i.content_type, i.bytes, i.byte_size, i.sha256, i.captured_at
           FROM desk_client_identity_documents d
           JOIN desk_clients c ON c.client_id = d.client_id
           LEFT JOIN LATERAL (
             SELECT * FROM desk_client_images x
              WHERE x.document_id = d.document_id AND x.purpose='identity_document'
              ORDER BY x.captured_at DESC LIMIT 1
           ) i ON true
          WHERE d.document_id=$1 AND d.client_id=$2
            AND c.tenant_id=$3 AND c.legal_entity_id=$4`,
        [documentId, clientId, ...entityScope(actor)],
      );
      if (!found.rowCount) throw documentNotFound();
      const row = found.rows[0]!;
      if (!row.image_id)
        throw new LedgerError(
          "SCAN_NOT_ON_FILE",
          "This desk holds no scan of that document — only the details typed from it.",
        );
      /* Written BEFORE the answer is built, in the same transaction, so
         that a reveal cannot succeed with its record rolled back. The
         document TYPE is named and its number is not: the audit trail is
         a record of who looked, not a second copy of what they saw. */
      await this.audit(
        client,
        actor,
        "client.document.view",
        clientId,
        `${row.display_name} · ${row.doc_type}${purpose ? ` · ${purpose.trim().slice(0, 200)}` : ""}`,
        documentId,
      );
      return {
        clientId,
        documentId,
        docType: row.doc_type as string,
        contentType: row.content_type as string,
        byteSize: row.byte_size as number,
        sha256: row.sha256 as string,
        capturedAt: new Date(row.captured_at).toISOString(),
        dataUrl: asDataUrl(row.content_type, row.bytes as Buffer),
        /* Said back to the caller so the screen can tell the teller,
           truthfully, that the desk recorded this. A control nobody is
           told about is a control nobody trusts. */
        recorded: { by: actor.userId, at: new Date().toISOString() },
      };
    });
  }

  /**
   * Who has looked at this customer's documents.
   *
   * The answer to the regulator's question, served from the same audit
   * table every other consequential act on this desk is written to.
   */
  async disclosures(actor: LedgerActor, clientId: string, limit: number) {
    return this.inTransaction(actor, "customer:view", async (client) => {
      const owned = await client.query(
        "SELECT display_name FROM desk_clients WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3",
        [clientId, ...entityScope(actor)],
      );
      if (!owned.rowCount) throw notFound();
      const rows = await client.query(
        `SELECT event_id,actor_id,action,target_id,reason,created_at,branch_id,workspace_id
           FROM ledger_audit_events
          WHERE tenant_id=$1 AND legal_entity_id=$2
            AND action LIKE 'client.%'
            AND (target_id=$3 OR reason LIKE $4)
          ORDER BY created_at DESC
          LIMIT $5`,
        [...entityScope(actor), clientId, `%${clientId}%`, limit],
      );
      return {
        clientId,
        legalName: owned.rows[0]!.display_name as string,
        events: rows.rows.map((row) => ({
          eventId: row.event_id,
          action: row.action,
          actorId: row.actor_id,
          branchId: row.branch_id,
          workspaceId: row.workspace_id,
          targetId: row.target_id,
          detail: row.reason,
          at: new Date(row.created_at).toISOString(),
        })),
      };
    });
  }

  /* ---- the photograph ------------------------------------------------
     Its own thing, not another entry in the ID list. Different purpose
     (recognising a regular at the counter), different sensitivity, and a
     different retention answer: an identity document is evidence the
     desk is obliged to keep, a photograph the desk took is a
     convenience it chose. Storing it as a document would make it
     inseparable from the first at exactly the moment somebody has to
     decide what to delete. */

  async setPhotograph(actor: LedgerActor, clientId: string, dataUrl: string) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const owned = await client.query(
        "SELECT 1 FROM desk_clients WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3",
        [clientId, ...entityScope(actor)],
      );
      if (!owned.rowCount) throw notFound();
      const imageId = await this.storeImage(client, actor, clientId, "client_photograph", dataUrl, null, null);
      await this.audit(client, actor, "client.photograph.set", clientId, "contact photograph replaced");
      return { clientId, imageId };
    });
  }

  /** Not audited as a document reveal — see the note above. */
  async photograph(actor: LedgerActor, clientId: string) {
    return this.inTransaction(actor, "customer:view", async (client) => {
      const found = await client.query(
        `SELECT i.content_type, i.bytes, i.captured_at
           FROM desk_client_images i
           JOIN desk_clients c ON c.client_id = i.client_id
          WHERE i.client_id=$1 AND i.purpose='client_photograph'
            AND c.tenant_id=$2 AND c.legal_entity_id=$3
          ORDER BY i.captured_at DESC LIMIT 1`,
        [clientId, ...entityScope(actor)],
      );
      if (!found.rowCount)
        throw new LedgerError("PHOTOGRAPH_NOT_ON_FILE", "No photograph is on file for this client.");
      const row = found.rows[0]!;
      return {
        clientId,
        contentType: row.content_type as string,
        capturedAt: new Date(row.captured_at).toISOString(),
        dataUrl: asDataUrl(row.content_type, row.bytes as Buffer),
      };
    });
  }

  /**
   * This customer, as the ledger's counter record for the active till.
   *
   * The row the posting path reads is workspace-scoped and stays that
   * way; what changes is that it carries `client_id`, so the ledger's row
   * and the desk's file are two views of one person rather than two
   * customers who happen to share a name. Called on every write above and
   * exposed on its own so the till can get a `customerId` to post
   * against without needing to know any of this.
   */
  async counterRecord(actor: LedgerActor, clientId: string) {
    return this.inTransaction(actor, "customer:write", async (client) => {
      const customerId = await this.syncCounterRecord(client, actor, clientId);
      if (!customerId) throw notFound();
      return { clientId, customerId, workspaceId: actor.workspaceId };
    });
  }

  private async syncCounterRecord(
    client: pg.PoolClient,
    actor: LedgerActor,
    clientId: string,
  ): Promise<string | null> {
    const found = await client.query(
      `SELECT c.display_name, c.risk_rating, c.verification_status,
              (SELECT min(expires_on) FROM desk_client_identity_documents d
                WHERE d.client_id=c.client_id AND d.is_primary) AS primary_expiry,
              (SELECT count(*)::int FROM desk_client_identity_documents d
                WHERE d.client_id=c.client_id AND coalesce(btrim(d.doc_number),'')<>'') AS numbered
         FROM desk_clients c
        WHERE c.client_id=$1 AND c.tenant_id=$2 AND c.legal_entity_id=$3`,
      [clientId, ...entityScope(actor)],
    );
    if (!found.rowCount) return null;
    const row = found.rows[0]!;
    /* The ledger's four-state word, derived rather than stored twice.
       An identity with no numbered document is "missing" whatever the
       desk's own status column says, and a primary document past its
       expiry is "expired" — the two states the posting gate actually
       acts on, computed from the documents rather than from a field
       somebody forgot to update. */
    const expired =
      row.primary_expiry != null && new Date(row.primary_expiry) < new Date(new Date().toDateString());
    const status: VerificationStatus =
      row.numbered === 0
        ? "unverified"
        : expired
          ? "expired"
          : (row.verification_status as VerificationStatus);
    const externalRef = `client:${clientId}`;
    const existing = await client.query(
      `SELECT customer_id FROM ledger_customers
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4
          AND client_id=$5
        LIMIT 1`,
      [actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, clientId],
    );
    if (existing.rowCount) {
      const customerId = existing.rows[0]!.customer_id as string;
      await client.query(
        `UPDATE ledger_customers
            SET name=$2, risk=$3, id_status=$4, updated_by=$5, updated_at=now()
          WHERE customer_id=$1`,
        [
          customerId,
          row.display_name,
          LEDGER_RISK[row.risk_rating as RiskRating],
          LEDGER_ID_STATUS[status],
          actor.userId,
        ],
      );
      return customerId;
    }
    /* A row the browser's legacy sync already made for this workspace,
       adopted rather than duplicated. `os:<slug-of-name>` is what
       cdos-backend.js has always sent; matching it once, here, is how a
       desk mid-upgrade ends up with one customer instead of two. */
    const adopted = await client.query(
      `UPDATE ledger_customers
          SET client_id=$5, name=$6, risk=$7, id_status=$8, updated_by=$9, updated_at=now()
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4
          AND client_id IS NULL
          AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))=$10
        RETURNING customer_id`,
      [
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
        actor.workspaceId,
        clientId,
        row.display_name,
        LEDGER_RISK[row.risk_rating as RiskRating],
        LEDGER_ID_STATUS[status],
        actor.userId,
        nameKey(row.display_name as string),
      ],
    );
    if (adopted.rowCount) return adopted.rows[0]!.customer_id as string;
    const customerId = `cust_${randomUUID()}`;
    await client.query(
      `INSERT INTO ledger_customers
        (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,
         external_ref,name,risk,id_status,client_id,created_by,updated_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,now(),now())`,
      [
        customerId,
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
        actor.workspaceId,
        externalRef,
        row.display_name,
        LEDGER_RISK[row.risk_rating as RiskRating],
        LEDGER_ID_STATUS[status],
        clientId,
        actor.userId,
      ],
    );
    return customerId;
  }

  /**
   * What the papers on file now say about this identity.
   *
   * Derived from the documents rather than typed, because a status
   * somebody has to remember to change is a status that goes stale — the
   * old store's `idStatus` was recomputed in the browser on every render
   * for exactly that reason, and then only in the browser.
   *
   * `verified` is never touched here. It means a provider authenticated
   * the document and was paid to do it; no amount of adding and removing
   * rows in this table can grant that, and nothing here may quietly take
   * it away either. The three states this DOES own are the ones that
   * follow mechanically from what the desk is holding.
   */
  private async refreshVerification(client: pg.PoolClient, clientId: string) {
    await client.query(
      `UPDATE desk_clients c
          SET verification_status = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM desk_client_identity_documents d
               WHERE d.client_id=c.client_id AND coalesce(btrim(d.doc_number),'') <> ''
            ) THEN 'unverified'
            WHEN EXISTS (
              SELECT 1 FROM desk_client_identity_documents d
               WHERE d.client_id=c.client_id AND d.is_primary
                 AND d.expires_on IS NOT NULL AND d.expires_on < current_date
            ) THEN 'expired'
            ELSE 'identified'
          END
        WHERE c.client_id=$1 AND c.verification_status <> 'verified'`,
      [clientId],
    );
  }

  private async hasPrimary(client: pg.PoolClient, clientId: string) {
    const found = await client.query(
      "SELECT 1 FROM desk_client_identity_documents WHERE client_id=$1 AND is_primary",
      [clientId],
    );
    return !!found.rowCount;
  }

  private async storeImage(
    client: pg.PoolClient,
    actor: LedgerActor,
    clientId: string,
    purpose: "identity_document" | "client_photograph",
    dataUrl: string,
    documentId: string | null,
    label: string | null,
  ) {
    const { contentType, bytes } = decodeDataUrl(dataUrl);
    const imageId = `img_${randomUUID()}`;
    await client.query(
      `INSERT INTO desk_client_images
        (image_id,client_id,tenant_id,legal_entity_id,purpose,document_id,
         content_type,byte_size,sha256,bytes,label,captured_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        imageId,
        clientId,
        ...entityScope(actor),
        purpose,
        documentId,
        contentType,
        bytes.length,
        createHash("sha256").update(bytes).digest("hex"),
        bytes,
        label,
        actor.userId,
      ],
    );
    return imageId;
  }

  private async audit(
    client: pg.PoolClient,
    actor: LedgerActor,
    action: string,
    clientId: string,
    detail: string,
    targetId?: string,
  ) {
    await client.query(
      `INSERT INTO ledger_audit_events
        (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
         action,target_id,reason,correlation_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
      [
        randomUUID(),
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
        actor.workspaceId,
        actor.userId,
        action,
        targetId ?? clientId,
        /* The client id rides in the detail as well as the target so a
           document reveal — whose target is the DOCUMENT — is still
           findable by the customer it belongs to. */
        `${clientId} · ${detail}`,
        randomUUID(),
      ],
    );
  }
}

const notFound = () =>
  new LedgerError("CLIENT_NOT_FOUND", "That customer is not on this desk's records.");

const documentNotFound = () =>
  new LedgerError(
    "CLIENT_DOCUMENT_NOT_FOUND",
    "That identity document is not on this customer's file.",
  );

/* An empty string is a field somebody cleared, and a cleared field is
   NULL. Storing "" would make "no date of birth recorded" and "date of
   birth recorded as nothing" two different states nobody can tell
   apart. */
const blank = (value: string | null | undefined) => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const isoDate = (value: unknown) =>
  value == null ? null : new Date(value as string | Date).toISOString().slice(0, 10);

function clientJson(
  row: Record<string, unknown>,
  documents: Record<string, unknown>[],
  aliases: Record<string, unknown>[],
  scanCount: Map<unknown, number>,
  photograph: Record<string, unknown> | null,
  sameNameClientIds: string[],
) {
  return {
    clientId: row.client_id,
    kind: row.kind,
    legalName: row.display_name,
    aliases: aliases.map((alias) => ({
      aliasId: alias.alias_id,
      alias: alias.alias,
      kind: alias.alias_kind,
      createdAt: new Date(alias.created_at as string | Date).toISOString(),
    })),
    dateOfBirth: isoDate(row.date_of_birth),
    addressLine: row.address_line ?? null,
    city: row.city ?? null,
    region: row.region ?? null,
    postalCode: row.postal_code ?? null,
    country: row.country ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    occupation: row.occupation ?? null,
    notes: row.notes ?? null,
    riskRating: row.risk_rating,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at ? new Date(row.verified_at as string | Date).toISOString() : null,
    screeningOutcome: row.screening_outcome ?? null,
    screeningMatched: row.screening_matched ?? null,
    screenedAt: row.screened_at ? new Date(row.screened_at as string | Date).toISOString() : null,
    incorporationDate: isoDate(row.incorporation_date),
    incorporationJurisdiction: row.incorporation_jurisdiction ?? null,
    natureOfBusiness: row.nature_of_business ?? null,
    contactName: row.contact_name ?? null,
    contactTitle: row.contact_title ?? null,
    possibleDuplicate: row.possible_duplicate,
    duplicateReason: row.duplicate_reason ?? null,
    /* Said on every read, not only at creation. A desk that has two
       David Chens should be reminded every time it opens either of
       them. */
    sameNameClientIds,
    /* Metadata only. `hasScan` is what lets a screen draw the covered
       placeholder without the bytes ever being on the wire until
       somebody clicks, which is what makes the audit row meaningful. */
    documents: documents.map((document) => ({
      documentId: document.document_id,
      docType: document.doc_type,
      docNumber: document.doc_number ?? null,
      issuingJurisdiction: document.issuing_jurisdiction ?? null,
      issuedOn: isoDate(document.issued_on),
      expiresOn: isoDate(document.expires_on),
      isPrimary: document.is_primary,
      hasScan: (scanCount.get(document.document_id) ?? 0) > 0,
    })),
    photograph: photograph
      ? {
          imageId: photograph.image_id,
          capturedAt: new Date(photograph.captured_at as string | Date).toISOString(),
        }
      : null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
