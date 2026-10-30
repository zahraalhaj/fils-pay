package settlement

import (
	"context"
	"testing"
)

// #66: the lifetime counter must keep counting past int32 max (~2.15M BD)
// instead of wrapping negative and switching the volume tier off again.
func TestPlatformProcessedVolume_PastInt32Max(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const start int64 = 2_100_000_000 // just above the tier threshold
	if err := RecordPlatformProcessedVolume(ctx, tx, 0, start); err != nil {
		t.Fatalf("seed: %v", err)
	}
	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 100_000_000); err != nil {
		t.Fatalf("RecordPlatformProcessedVolume past int32 max: %v", err)
	}
	total, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if total != 2_200_000_000 {
		t.Errorf("total = %d, want 2200000000 (no wraparound)", total)
	}
	if VolumeTierMdrBonusBps(total) != 15 {
		t.Errorf("tier switched off past int32 max")
	}
}
