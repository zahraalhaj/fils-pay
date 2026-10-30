package settlement

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Two settlement runs must never overlap, whichever process starts them.
func TestRunDailyBatch_RefusesWhileAnotherRunHoldsTheLock(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	date := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	nobody := uuid.New() // not a real merchant: only the lock outcome matters here

	holder, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_lock($1)`, runLockKey); err != nil {
		t.Fatalf("lock: %v", err)
	}

	_, err = RunDailyBatch(ctx, pool, date, &nobody)
	if !errors.Is(err, ErrRunInProgress) {
		t.Fatalf("expected ErrRunInProgress while the lock is held, got %v", err)
	}

	if _, err := holder.Exec(ctx, `SELECT pg_advisory_unlock($1)`, runLockKey); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	holder.Release()

	if _, err := RunDailyBatch(ctx, pool, date, &nobody); errors.Is(err, ErrRunInProgress) {
		t.Fatalf("run refused after the lock was released")
	}
	// That run released its own lock, even though it failed: the next run is not refused either.
	if _, err := RunDailyBatch(ctx, pool, date, &nobody); errors.Is(err, ErrRunInProgress) {
		t.Fatalf("run refused after the previous run finished")
	}
}

// A cancelled run (SIGTERM on redeploy) stops before touching any merchant.
func TestRunDailyBatch_StopsBeforeNextMerchantWhenCancelled(t *testing.T) {
	pool := mustPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	nobody := uuid.New()
	cancel()
	_, err := RunDailyBatch(ctx, pool, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), &nobody)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}
