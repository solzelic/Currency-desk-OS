-- Identity-verification settings per shop. 049 is reserved. This file is 050.
-- provider defaults to persona. api_key_ref is an environment variable name. checks default off.

CREATE TABLE IF NOT EXISTS idv_shop_config (
  shop_id text PRIMARY KEY REFERENCES legal_entities(id),
  provider text NOT NULL DEFAULT 'persona',
  api_key_ref text,
  template_id text,
  retention_days integer,
  checks_enabled boolean NOT NULL DEFAULT false,
  CONSTRAINT idv_shop_config_provider_shape CHECK (
    provider ~ '^[a-z][a-z0-9_-]{0,31}$'
  ),
  CONSTRAINT idv_shop_config_retention_days CHECK (
    retention_days IS NULL OR (retention_days BETWEEN 1 AND 3650)
  ),
  CONSTRAINT idv_shop_config_api_key_ref_shape CHECK (
    api_key_ref IS NULL OR api_key_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  CONSTRAINT idv_shop_config_template_id_shape CHECK (
    template_id IS NULL OR (
      char_length(template_id) BETWEEN 1 AND 80
      AND template_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
    )
  )
);
