/* Replace stored health numbers with a marker.

   This command does not run on deploy. src/index.ts does not import it,
   and it is not a migration. The review route does import the report
   (routes.ts loads health-numbers.js); this file does not. Dry-run is
   the default. It prints counts and document ids, and changes nothing.
   Filings and scans are left for Compliance.

     DATABASE_URL=postgres://… npx tsx src/clients/redact-health-numbers-cli.ts --actor j.masri
     DATABASE_URL=postgres://… npx tsx src/clients/redact-health-numbers-cli.ts --apply --actor j.masri

   --actor is a staff id or a full user id. The actor must be the owner
   (administrator) or the compliance officer of that shop. The command
   redacts that shop only.
*/
import pg from "pg";
import { redactHealthNumbers, resolveRedactionActor } from "./health-numbers.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let apply = false;
  let dryRun = false;
  let actor = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--actor") {
      actor = argv[i + 1] ?? "";
      if (!actor || actor.startsWith("--")) fail("--actor needs a staff id.");
      i += 1;
    } else fail(`Unknown argument "${arg}". Use --dry-run, or --apply --actor <staff id>.`);
  }
  if (apply && dryRun) fail("Pass either --apply or --dry-run, not both.");
  if (apply && !actor) fail("--apply requires --actor <staff id>. Dry-run is the default and changes nothing.");
  return { apply, actor };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required. This command does not run on deploy.");

const { apply, actor: actorKey } = parseArgs(process.argv.slice(2));
if (!actorKey) fail("Pass --actor <staff id> so the count is for one shop. Add --apply to change rows.");

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const actor = await resolveRedactionActor(pool, actorKey);
  const counts = await redactHealthNumbers(pool, actor, apply);
  console.log(`shop: ${counts.tenantId} / ${counts.legalEntityId}`);
  console.log(`health numbers still stored: ${counts.stored}`);
  console.log(`already redacted: ${counts.alreadyRedacted}`);
  console.log(`posted deals that relied on a health card: ${counts.deals}`);
  if (counts.documentIds.length) {
    console.log("document ids:");
    for (const documentId of counts.documentIds) console.log(documentId);
  } else {
    console.log("document ids: none");
  }
  console.log("filings and scans were not changed. Compliance is ruling on them.");
  if (apply) console.log(`redacted: ${counts.redacted}`);
  else console.log("dry-run: nothing was changed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await pool.end();
  process.exit(1);
}
await pool.end();
