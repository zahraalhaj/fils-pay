-- Additional suspense accounts for future reconciliation lanes.
-- chart_of_accounts is (id, name, kind) with kind in asset/liability/revenue
-- (0007); suspense accounts are assets, like scheme_rounding_residue.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference (suspense)', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
