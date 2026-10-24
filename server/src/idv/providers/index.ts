/* Registered providers. The first is the default when the owner omits one. */
import type { IdvSettingsProvider } from "../provider.js";
import { personaProvider } from "./persona.js";

const providers: readonly IdvSettingsProvider[] = [personaProvider];

export function idvProvider(id: string): IdvSettingsProvider | undefined {
  return providers.find((item) => item.id === id);
}

export function defaultIdvProvider(): IdvSettingsProvider {
  return providers[0]!;
}
