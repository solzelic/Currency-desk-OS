/* Append-only Persona results. The row stores ids and a status.
   A reference is kept only when it is a client id on this desk.
   A name, a date of birth, or a document number is not a column. */
import { sql } from "drizzle-orm";
import { audit } from "../audit.js";
import { schema, type Db } from "../db/index.js";
import type { PersonaEnvironment, PersonaEventRecord } from "./persona.js";

export async function recordPersonaEvent(
  db: Db,
  event: PersonaEventRecord,
  environment: PersonaEnvironment,
): Promise<"stored" | "duplicate"> {
  const linked = event.clientId ? await lookupClient(db, event.clientId) : null;
  let outcome: "stored" | "duplicate" = "duplicate";
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(schema.personaInquiryEvents).values({
      eventId: event.eventId,
      inquiryId: event.inquiryId,
      eventName: event.eventName,
      status: event.status,
      clientId: linked?.clientId ?? null,
      tenantId: linked?.tenantId ?? null,
      legalEntityId: linked?.legalEntityId ?? null,
      environment,
    }).onConflictDoNothing().returning();
    if (inserted.length === 0) {
      outcome = "duplicate";
      return;
    }
    outcome = "stored";
    if (!linked) return;
    if (!linked.branchId) {
      console.warn(`[persona] recorded ${event.eventId} for ${linked.clientId} without an audit row: the desk has no branch`);
      return;
    }
    await audit(tx as Db, {
      tenantId: linked.tenantId,
      legalEntityId: linked.legalEntityId,
      branchId: linked.branchId,
      action: "kyc.persona.recorded",
      detail: {
        eventId: event.eventId,
        inquiryId: event.inquiryId,
        status: event.status,
        clientId: linked.clientId,
      },
    });
  });
  return outcome;
}

async function lookupClient(db: Db, clientId: string): Promise<{
  clientId: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string | null;
} | null> {
  const found = await db.execute(sql`
    SELECT c.client_id, c.tenant_id, c.legal_entity_id,
           (SELECT b.id FROM branches b
             WHERE b.tenant_id = c.tenant_id AND b.legal_entity_id = c.legal_entity_id
             ORDER BY b.id LIMIT 1) AS branch_id
      FROM desk_clients c
     WHERE c.client_id = ${clientId}`);
  const row = (found.rows ?? [])[0] as {
    client_id: string;
    tenant_id: string;
    legal_entity_id: string;
    branch_id: string | null;
  } | undefined;
  if (!row) return null;
  return {
    clientId: row.client_id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
  };
}
