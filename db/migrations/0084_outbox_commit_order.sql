-- Reporting consumed outbox_events by id, but ids are assigned at INSERT and
-- become visible at COMMIT: a transaction holding id N could commit after
-- N+1 was consumed and the watermark had moved past it, so N was never
-- applied (#74). Each row now records the transaction that wrote it, and a
-- consumer reads only rows whose transaction is older than every transaction
-- still running (pg_snapshot_xmin), in (txid, id) order. No row can later
-- appear behind that position.
--
-- Existing rows get txid 0 (added with a constant default, no rewrite), so
-- they sort before every new row and keep their old id order; the default
-- for new rows is switched afterwards.

ALTER TABLE outbox_events ADD COLUMN txid xid8 NOT NULL DEFAULT '0';
ALTER TABLE outbox_events ALTER COLUMN txid SET DEFAULT pg_current_xact_id();
CREATE INDEX idx_outbox_events_txid_id ON outbox_events (txid, id);

ALTER TABLE reporting_outbox_cursor ADD COLUMN last_processed_txid xid8 NOT NULL DEFAULT '0';
