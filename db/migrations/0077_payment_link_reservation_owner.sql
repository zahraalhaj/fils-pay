-- FP-202 / incident 2026-05-14: a payment link could be paid twice when a
-- slow attempt outlived its reservation and a second buyer re-claimed it.
-- Each claim now gets its own reservation_id; capture only proceeds while
-- that attempt still holds the reservation, and marks the link paid in the
-- same transaction as the capture.

ALTER TABLE payment_links ADD COLUMN reservation_id UUID;
