-- Verifications get the same door stamp as raises, joins and grants (see 0004_doors.sql),
-- so a Verification shows in the activity feeds (/agents, /m/{slug}) with the door it came through.
-- Additive only. Rows written before this migration keep via_door = '' ("door not recorded").
ALTER TABLE verifications ADD COLUMN via_door    TEXT NOT NULL DEFAULT '';
ALTER TABLE verifications ADD COLUMN via_label   TEXT NOT NULL DEFAULT '';
ALTER TABLE verifications ADD COLUMN via_channel TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS verifications_muse ON verifications(muse_id, checked_at);
