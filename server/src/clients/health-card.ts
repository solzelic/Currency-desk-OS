/* Health cards are not valid ID.

   The names live in shared/health-card-names.js, which the browser
   loads as the same file. PR #108's catalogue is not on this branch.
   Its health-card row should import that list when the two meet, so
   a provincial name is refused on write and omitted on read together. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type HealthCardModule = {
  HEALTH_CARD_NAMES: readonly string[];
  HEALTH_CARD_TYPE_KEYS: readonly string[];
  typeKey: (value: unknown) => string;
  isHealthCardType: (value: unknown) => boolean;
  scrubHealthNumbers: <T>(value: T) => T;
  healthCardExcludedSql: (expr: string) => string;
};

const shared = require("../../../shared/health-card-names.js") as HealthCardModule;

export const HEALTH_CARD_NAMES = shared.HEALTH_CARD_NAMES;
export const HEALTH_CARD_TYPE_KEYS = shared.HEALTH_CARD_TYPE_KEYS;
export const typeKey = shared.typeKey;
export const isHealthCardType = shared.isHealthCardType;
export const scrubHealthNumbers = shared.scrubHealthNumbers;
export const healthCardExcludedSql = shared.healthCardExcludedSql;

/* The same refusal PR #108 raises on its catalogue path
   (HEALTH_CARD_NOT_ID). That path is not on this branch. */
export const HEALTH_CARD_REFUSAL =
  "Health cards can't be used as ID. Record a current photo ID.";
