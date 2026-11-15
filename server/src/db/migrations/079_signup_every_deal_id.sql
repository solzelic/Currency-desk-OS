-- Signup v2.1 explicitly offers "every exchange". NULL still follows the
-- pack; zero is an explicit stricter desk choice, never a missing figure.
ALTER TABLE legal_entities DROP CONSTRAINT IF EXISTS legal_entities_id_threshold_check;
ALTER TABLE legal_entities ADD CONSTRAINT legal_entities_id_threshold_check
  CHECK (id_threshold IS NULL OR id_threshold >= 0);
