-- Usage receipt on a Verification (#29): optional, self-reported by the verifying Muse from its own session log
-- (model, model calls, tokens, model time) as JSON. RAISE cannot check it; pages label it "reported by the Muse from its
-- session log". Additive only: NULL for every Verification written before this migration and for any sent without one.
ALTER TABLE verifications ADD COLUMN receipt_json TEXT;
