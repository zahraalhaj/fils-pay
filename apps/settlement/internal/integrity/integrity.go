// Package integrity drives the tamper-evidence anchors of migration 0085:
// a daily, chained SHA-256 digest of ledger_entries and admin_audit_log
// rows, computed in Postgres. Anchoring adds nothing to the write path.
package integrity

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Problem is one anchored day whose rows or anchor chain no longer match.
type Problem struct {
	Table   string
	Day     time.Time
	Problem string
}

// AnchorClosedDays anchors every closed, not-yet-anchored UTC day and
// returns how many anchors it wrote. A no-op when nothing new has closed.
func AnchorClosedDays(ctx context.Context, db *pgxpool.Pool) (int, error) {
	var written int
	if err := db.QueryRow(ctx, `SELECT anchor_closed_days()`).Scan(&written); err != nil {
		return 0, fmt.Errorf("integrity: anchor_closed_days: %w", err)
	}
	return written, nil
}

// Verify recomputes every anchor. An empty result means nothing anchored
// has been altered.
func Verify(ctx context.Context, db *pgxpool.Pool) ([]Problem, error) {
	rows, err := db.Query(ctx, `SELECT table_name, day, problem FROM verify_integrity()`)
	if err != nil {
		return nil, fmt.Errorf("integrity: verify_integrity: %w", err)
	}
	defer rows.Close()
	var problems []Problem
	for rows.Next() {
		var p Problem
		if err := rows.Scan(&p.Table, &p.Day, &p.Problem); err != nil {
			return nil, fmt.Errorf("integrity: scan: %w", err)
		}
		problems = append(problems, p)
	}
	return problems, rows.Err()
}
