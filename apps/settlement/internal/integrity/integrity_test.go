package integrity

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Anchors a balanced ledger group on an old day, then tampers with it the
// way an owner of the table could (triggers disabled) and expects
// verify_integrity to name that day. Everything runs in one rolled-back
// transaction, so the shared database is left untouched.
func TestVerifyIntegrity_DetectsRewrittenLedgerRows(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)

	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	problemsFor := func(day string) []string {
		t.Helper()
		rows, err := tx.Query(ctx, `SELECT problem FROM verify_integrity() WHERE table_name = 'ledger_entries' AND day = $1::date`, day)
		if err != nil {
			t.Fatalf("verify: %v", err)
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatalf("collect: %v", err)
		}
		return found
	}

	// Start from no anchors so the test day is anchored fresh.
	mustExec(`ALTER TABLE integrity_anchors DISABLE TRIGGER integrity_anchors_append_only`)
	mustExec(`DELETE FROM integrity_anchors`)
	mustExec(`ALTER TABLE integrity_anchors ENABLE TRIGGER integrity_anchors_append_only`)

	const day = "2001-02-03"
	var merchantID string
	if err := tx.QueryRow(ctx, `INSERT INTO merchants (display_name, mdr_bps) VALUES ('integrity test', 250) RETURNING id`).Scan(&merchantID); err != nil {
		t.Fatalf("merchant: %v", err)
	}
	mustExec(`INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, created_at)
	          SELECT g, $1, a, d, 4750, $2::date + time '10:00', $2::date + time '10:00'
	            FROM gen_random_uuid() g, (VALUES ('card_scheme_clearing', 'debit'), ('merchant_payable', 'credit')) v(a, d)`,
		merchantID, day)

	var written int
	if err := tx.QueryRow(ctx, `SELECT anchor_closed_days()`).Scan(&written); err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if written == 0 {
		t.Fatal("expected anchors to be written")
	}
	if got := problemsFor(day); len(got) != 0 {
		t.Fatalf("freshly anchored day reported as tampered: %v", got)
	}

	// Rewrite both legs (still balanced) behind the append-only trigger.
	mustExec(`SET CONSTRAINTS ALL IMMEDIATE`) // run the pending balance check first
	mustExec(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only`)
	mustExec(`UPDATE ledger_entries SET amount_fils = 475 WHERE merchant_id = $1`, merchantID)
	mustExec(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only`)

	if got := problemsFor(day); len(got) != 1 {
		t.Fatalf("expected the rewritten day to be reported once, got %v", got)
	}
}
