/* Why a desk can or cannot start an identity check.
   The same answer is on the client file and on the consent read.
   Staging still refuses a customer link until privacyReady is true.
   This does not change the live lock or tier 4. */
import { isStagingRuntime } from "../auth/staging-runtime.js";
import type { Db } from "../db/index.js";
import { privacyReady } from "./consent-copy.js";
import { diditConfigured, diditRuntimeAllowed } from "./providers/didit.js";
import { personaApiKey } from "./providers/persona.js";
import { consentFill, dbQuery, loadShopIdv, type DeskActor } from "./records.js";
import { shopEnvCodeFor } from "./shop-config.js";

export type IdvReady = "off" | "not_test_shop" | "not_configured" | "privacy_missing" | "ok";

export function idvReadyReason(input: {
  checksEnabled: boolean;
  provider: string;
  testShop: boolean;
  env: NodeJS.ProcessEnv;
  privacyIsReady: boolean;
  personaConnected: boolean;
}): IdvReady {
  if (!input.checksEnabled) return "off";
  if (input.provider === "didit") {
    if (!input.testShop) return "not_test_shop";
    if (!diditRuntimeAllowed(input.env) || !diditConfigured(input.env)) return "not_configured";
  } else if (!input.personaConnected) {
    return "not_configured";
  }
  if (isStagingRuntime(undefined, input.env) && !input.privacyIsReady) return "privacy_missing";
  return "ok";
}

export async function readIdvReady(db: Db, actor: DeskActor, env: NodeJS.ProcessEnv): Promise<{
  provider: "persona" | "didit";
  ready: IdvReady;
  checksEnabled: boolean;
  testShop: boolean;
}> {
  const shop = await loadShopIdv(db, actor.legalEntityId);
  const provider = shop.provider === "didit" ? "didit" : "persona";
  const tenant = await dbQuery(db).query("SELECT is_test_shop FROM tenants WHERE id = $1", [actor.tenantId]);
  const testShop = tenant.rows[0]?.is_test_shop === true;
  const fill = await consentFill(db, actor);
  const personaConnected = provider === "persona" && personaApiKey({
    apiKeyRef: shop.apiKeyRef,
    shopCode: await shopEnvCodeFor(db, actor.tenantId),
  }, env) !== null;
  return {
    provider,
    checksEnabled: shop.checksEnabled,
    testShop,
    ready: idvReadyReason({
      checksEnabled: shop.checksEnabled,
      provider,
      testShop,
      env,
      privacyIsReady: privacyReady(fill),
      personaConnected,
    }),
  };
}
