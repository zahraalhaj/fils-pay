-- FP-201 (reopened): the acquirer re-sends a callback when our ack is slow,
-- and each re-send was stored as another note. One note per acquirer
-- callback per transaction; the handler inserts with ON CONFLICT DO NOTHING.
-- Keyed with transaction_id too because the sandbox has been seen reusing
-- callback ids across different transactions (postmortem 2026-05).

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback
    ON acquirer_callback_notes (callback_id, transaction_id);
