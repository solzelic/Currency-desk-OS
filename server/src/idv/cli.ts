/* Persona CLI. No HTTP route.
     npm run persona -- register-webhook
   Reads the shared API key. Refuses unless this process is a staging
   runtime. --production is refused until go-live (CD-219). The signing secret is printed
   on stdout once and is not logged. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPersonaWebhook } from "./register-webhook.js";

export async function runPersonaCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return registerPersonaWebhook(argv, env, {
    stdout: (line) => { process.stdout.write(`${line}\n`); },
    stderr: (line) => { process.stderr.write(`${line}\n`); },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runPersonaCli(process.argv.slice(2));
}
