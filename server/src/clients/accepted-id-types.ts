/* ============================================================
   Settings → Accepted IDs: which ID types this shop takes.

   The owner asked for it in these words: "all that stuff should be
   toggled in settings like accepted IDs, not accepted IDs, within
   reason". The "within reason" is the pack. A pack can lock a type off
   (server/src/ledger/id-type-rules.ts) and a shop must keep at least
   one photo ID. Inside that, the owner decides.

   STORED. `legal_entities.accepted_id_types`, catalogue codes, beside
   `traded_currencies` and for the same reason: it is how the business
   operates, not one counter. NULL means "follow the pack". A save that
   lands exactly on the pack's defaults stores NULL again, so a shop
   that switches something off and back on is following the pack, and
   picks up whatever the pack says next.

   WHO. Every role can read the list, because the ID picker at every
   counter needs it. Changing it is `compliance:thresholds`, the
   owner's, the same permission as the reporting line and the currency
   set (see the header of server/src/ledger/currency-control.ts).

   AUDITED. A change writes one `ledger_audit_events` row naming what
   was switched on and off. It never names a document number. It does
   say how many IDs already on file are a type just switched off,
   because that is what somebody will ask later.

   NOTHING ON FILE CHANGES. A customer whose ID is a type this shop has
   switched off keeps that document and its verification status. The
   read flags it (records.ts). No row is rewritten here.
   ============================================================ */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolvePack, type JurisdictionPack } from "../ledger/jurisdiction.js";
import { authorizeLedgerActor } from "../ledger/principal.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import {
  acceptedCodes,
  idTypeRulesFor,
  keepsPhotoId,
  type IdTypeRule,
} from "../ledger/id-type-rules.js";
import {
  ID_DOCUMENT_TYPES,
  resolveIdType,
  typeKey,
  typeKeySql,
  type IdDocumentKind,
} from "./id-document-types.js";

export type AcceptedIdType = IdTypeRule & { on: boolean };

export type AcceptedIdTypes = {
  packId: string;
  packName: string;
  /** nothing stated: the pack's defaults apply */
  followsPack: boolean;
  /** the codes this shop accepts, in catalogue order */
  accepted: string[];
  /** every catalogue type, on or off, with its lock */
  types: AcceptedIdType[];
};

export type AcceptedIdTypesView = AcceptedIdTypes & {
  /** the person asking may change it. The server decides; the desk
      only draws the switches read-only when this is false. */
  canChange: boolean;
};

export const OWNER_ONLY = "Only the owner can change which IDs this shop accepts.";
export const KEEP_A_PHOTO_ID = "Keep at least one photo ID switched on.";

function shape(pack: JurisdictionPack, stored: readonly string[] | null): AcceptedIdTypes {
  const rules = idTypeRulesFor(pack.jurisdiction);
  const accepted = acceptedCodes(rules, stored);
  const on = new Set(accepted);
  return {
    packId: pack.packId,
    packName: pack.name,
    followsPack: stored === null,
    accepted,
    types: rules.map((rule) => ({ ...rule, on: on.has(rule.code) })),
  };
}

/** This shop's list, inside the caller's transaction. */
export async function resolveAcceptedIdTypes(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<AcceptedIdTypes> {
  const pack = await resolvePack(client, legalEntityId);
  const found = await client.query(
    "SELECT accepted_id_types FROM legal_entities WHERE id=$1",
    [legalEntityId],
  );
  const raw = found.rows[0]?.accepted_id_types;
  return shape(pack, Array.isArray(raw) ? raw.map(String) : null);
}

/** The labels this shop accepts, optionally of one kind. Catalogue order. */
export function acceptedLabels(shop: AcceptedIdTypes, kind?: IdDocumentKind): string[] {
  return shop.types
    .filter((type) => type.on && (!kind || type.kind === kind))
    .map((type) => type.label);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((code, i) => code === b[i]);

/* Every folded name a code goes by, for a query parameter. */
const keysFor = (codes: readonly string[]) =>
  ID_DOCUMENT_TYPES.filter((row) => codes.includes(row.code)).flatMap((row) =>
    [row.code, row.label, ...row.aliases].map(typeKey),
  );

export class AcceptedIdTypeService {
  constructor(private readonly pool: pg.Pool) {}

  private async inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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

  async current(actor: LedgerActor): Promise<AcceptedIdTypesView> {
    return this.inTransaction(async (client) => {
      const role = await authorizeLedgerActor(client, actor, "customer:view");
      const shop = await resolveAcceptedIdTypes(client, actor.legalEntityId);
      return { ...shop, canChange: hasBackendPermission(role, "compliance:thresholds") };
    });
  }

  /**
   * State the shop's list, or hand it back to the pack with null.
   *
   * Refused, with nothing written: a name that is not a catalogue type,
   * a locked type (the sentence carries the pack's note), and a list
   * with no person photo ID in it. Business types may all be off.
   */
  async set(actor: LedgerActor, codes: readonly string[] | null): Promise<AcceptedIdTypesView> {
    return this.inTransaction(async (client) => {
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const pack = await resolvePack(client, actor.legalEntityId);
      const rules = idTypeRulesFor(pack.jurisdiction);

      let stored: string[] | null = null;
      if (codes !== null) {
        const chosen = new Set<string>();
        for (const raw of codes) {
          const row = resolveIdType(raw);
          if (!row)
            throw new LedgerError(
              "ID_TYPE_NOT_IN_CATALOGUE",
              `"${String(raw).trim()}" isn't an ID type on the list.`,
            );
          const rule = rules.find((candidate) => candidate.code === row.code)!;
          if (rule.locked)
            throw new LedgerError("ID_TYPE_LOCKED", `${rule.label} can't be switched on. ${rule.note}`);
          chosen.add(rule.code);
        }
        if (!keepsPhotoId(rules, chosen)) throw new LedgerError("PHOTO_ID_REQUIRED", KEEP_A_PHOTO_ID);
        const ordered = rules.filter((rule) => chosen.has(rule.code)).map((rule) => rule.code);
        stored = sameList(ordered, acceptedCodes(rules, null)) ? null : ordered;
      }

      const before = await resolveAcceptedIdTypes(client, actor.legalEntityId);
      const updated = await client.query(
        "UPDATE legal_entities SET accepted_id_types=$2 WHERE id=$1",
        [actor.legalEntityId, stored],
      );
      if (!updated.rowCount)
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its accepted IDs cannot be set here.",
        );
      const after = await resolveAcceptedIdTypes(client, actor.legalEntityId);

      /* The row a person reads later: which types went on, which went
         off, and how many IDs already on file are a type just switched
         off. Labels and a count. Never a number off a document. */
      const label = (code: string) => rules.find((rule) => rule.code === code)!.label;
      const switchedOn = after.accepted.filter((code) => !before.accepted.includes(code));
      const switchedOff = before.accepted.filter((code) => !after.accepted.includes(code));
      const parts: string[] = [];
      if (switchedOn.length) parts.push(`switched on ${switchedOn.map(label).join(", ")}`);
      if (switchedOff.length) parts.push(`switched off ${switchedOff.map(label).join(", ")}`);
      if (!parts.length) parts.push("no change");
      if (after.followsPack) parts.push("following the pack");
      if (switchedOff.length) {
        const onFile = await client.query(
          `SELECT count(*)::int AS n FROM desk_client_identity_documents d
            WHERE d.tenant_id=$1 AND d.legal_entity_id=$2
              AND ${typeKeySql("d.doc_type")} = ANY($3::text[])`,
          [actor.tenantId, actor.legalEntityId, keysFor(switchedOff)],
        );
        const held = Number(onFile.rows[0]?.n ?? 0);
        if (held) parts.push(`${held} ${held === 1 ? "ID" : "IDs"} on file ${held === 1 ? "is" : "are"} a type now switched off`);
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'desk.id_types.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          `accepted IDs: ${parts.join("; ")}`,
          randomUUID(),
        ],
      );
      return { ...after, canChange: true };
    });
  }
}
