package settlement

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// Incident 2026-08-21: concurrent runs must not enqueue settlement.paid
// twice for the same batch.
func TestEnqueuePayoutNotificationsConcurrentRunsEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
		VALUES ($1, '2026-04-20', 'paid', 10000, 250, 9750, now(), now())
		RETURNING id
	`, merchantID).Scan(&batchID); err != nil {
		t.Fatalf("seed paid batch: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, batchID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("settlement.paid events for one batch = %d, want 1", n)
	}
}
