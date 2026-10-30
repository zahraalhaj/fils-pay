-- One malformed outbox event used to stall the reporting worker forever: a
-- pass is atomic, so it failed on the same event every time and the
-- watermark never moved. After repeated failures the worker now applies
-- events one at a time and parks any event that still fails here, so it is
-- visible and can be replayed once fixed, instead of blocking every report.

CREATE TABLE reporting_dead_letters (
    outbox_event_id BIGINT PRIMARY KEY REFERENCES outbox_events (id),
    consumer_name   TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    error           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
