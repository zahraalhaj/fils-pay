-- Incident 2026-08-21: two concurrent runs (daemon + CLI) both saw "not yet
-- notified" and both enqueued settlement.paid for the same batch, so shops
-- got two payout messages. One settlement.paid event per batch, enforced
-- by the database; the enqueue inserts with ON CONFLICT DO NOTHING.

CREATE UNIQUE INDEX uq_outbox_events_settlement_paid
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';
