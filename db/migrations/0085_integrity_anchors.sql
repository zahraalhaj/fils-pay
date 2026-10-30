-- Tamper evidence for the ledger and the admin audit log (#85).
--
-- 0007 makes every ledger group balance and 0081 makes both tables
-- append-only, but those are triggers: the role that owns the tables (the
-- application role, in every environment so far) can disable them, rewrite
-- history and re-enable them without a trace.
--
-- Once a UTC day has closed (plus a one-hour margin for late commits), the
-- settlement daemon records a SHA-256 digest of that day's rows here. Each
-- anchor also hashes the previous anchor of the same table, so the anchors
-- form a chain: editing a row breaks its day's digest, and editing an anchor
-- to match breaks every later link. verify_integrity() recomputes both.
-- Nothing is added to the write path, so it costs no throughput.
--
-- Hashed columns: every ledger_entries column, and the admin_audit_log
-- columns 0081 makes immutable (outcome and metadata may still be filled in
-- after the action, by design). Timestamps are hashed as epoch microseconds
-- so the digest does not depend on session TimeZone or DateStyle.

CREATE TABLE integrity_anchors (
    id                 BIGSERIAL PRIMARY KEY,
    table_name         TEXT   NOT NULL CHECK (table_name IN ('ledger_entries', 'admin_audit_log')),
    day                DATE   NOT NULL,
    row_count          BIGINT NOT NULL,
    rows_digest        BYTEA  NOT NULL,
    prev_anchor_digest BYTEA,
    anchor_digest      BYTEA  NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (table_name, day)
);

CREATE FUNCTION reject_integrity_anchor_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'integrity_anchors is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integrity_anchors_append_only
    BEFORE UPDATE OR DELETE ON integrity_anchors
    FOR EACH ROW EXECUTE FUNCTION reject_integrity_anchor_change();

CREATE FUNCTION integrity_epoch_us(ts TIMESTAMPTZ) RETURNS TEXT AS $$
    SELECT CASE WHEN ts IS NULL THEN '' ELSE (EXTRACT(EPOCH FROM ts) * 1000000)::BIGINT::TEXT END
$$ LANGUAGE sql IMMUTABLE;

-- Digest of one table's rows created on one UTC day, in a fixed order.
CREATE FUNCTION integrity_rows_digest(p_table TEXT, p_day DATE, OUT row_count BIGINT, OUT digest BYTEA) AS $$
DECLARE
    v_from TIMESTAMPTZ := p_day::TIMESTAMP AT TIME ZONE 'UTC';
    v_to   TIMESTAMPTZ := (p_day + 1)::TIMESTAMP AT TIME ZONE 'UTC';
    v_line TEXT;
BEGIN
    row_count := 0;
    digest := sha256(convert_to(p_table || '|' || p_day::TEXT, 'UTF8'));
    IF p_table = 'ledger_entries' THEN
        FOR v_line IN
            SELECT json_build_array(id, entry_group_id, merchant_id, transaction_id, settlement_batch_id,
                                    account_id, direction, amount_fils, integrity_epoch_us(occurred_at),
                                    description, integrity_epoch_us(created_at))::TEXT
              FROM ledger_entries
             WHERE created_at >= v_from AND created_at < v_to
             ORDER BY id
        LOOP
            digest := sha256(digest || convert_to(v_line, 'UTF8'));
            row_count := row_count + 1;
        END LOOP;
    ELSIF p_table = 'admin_audit_log' THEN
        FOR v_line IN
            SELECT json_build_array(id, admin_user_id, admin_role, action, target_type, target_id,
                                    integrity_epoch_us(created_at))::TEXT
              FROM admin_audit_log
             WHERE created_at >= v_from AND created_at < v_to
             ORDER BY created_at, id
        LOOP
            digest := sha256(digest || convert_to(v_line, 'UTF8'));
            row_count := row_count + 1;
        END LOOP;
    ELSE
        RAISE EXCEPTION 'integrity_rows_digest: unknown table %', p_table;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION integrity_anchor_digest(p_table TEXT, p_day DATE, p_count BIGINT, p_rows BYTEA, p_prev BYTEA)
RETURNS BYTEA AS $$
    SELECT sha256(convert_to(p_table || '|' || p_day::TEXT || '|' || p_count::TEXT, 'UTF8')
                  || p_rows || COALESCE(p_prev, ''::BYTEA))
$$ LANGUAGE sql IMMUTABLE;

-- Anchors every closed, not-yet-anchored day of both tables, oldest first.
-- Safe to call on every daemon tick: a no-op when nothing new has closed.
CREATE FUNCTION anchor_closed_days() RETURNS INTEGER AS $$
DECLARE
    v_table   TEXT;
    v_day     DATE;
    v_last    DATE;
    v_first   DATE;
    v_prev    BYTEA;
    v_count   BIGINT;
    v_rows    BYTEA;
    v_closed  DATE := ((now() - INTERVAL '1 hour') AT TIME ZONE 'UTC')::DATE - 1;
    v_written INTEGER := 0;
BEGIN
    -- One anchoring pass at a time, cluster-wide.
    PERFORM pg_advisory_xact_lock(hashtext('filspay.integrity_anchors'));
    FOREACH v_table IN ARRAY ARRAY['ledger_entries', 'admin_audit_log'] LOOP
        v_last := NULL;
        v_prev := NULL;
        SELECT ia.day, ia.anchor_digest INTO v_last, v_prev
          FROM integrity_anchors ia WHERE ia.table_name = v_table ORDER BY ia.day DESC LIMIT 1;
        IF v_last IS NULL THEN
            EXECUTE format('SELECT (min(created_at) AT TIME ZONE ''UTC'')::DATE FROM %I', v_table) INTO v_first;
            IF v_first IS NULL THEN CONTINUE; END IF;
            v_day := v_first;
        ELSE
            v_day := v_last + 1;
        END IF;
        WHILE v_day <= v_closed LOOP
            SELECT d.row_count, d.digest INTO v_count, v_rows FROM integrity_rows_digest(v_table, v_day) d;
            INSERT INTO integrity_anchors (table_name, day, row_count, rows_digest, prev_anchor_digest, anchor_digest)
            VALUES (v_table, v_day, v_count, v_rows, v_prev,
                    integrity_anchor_digest(v_table, v_day, v_count, v_rows, v_prev))
            RETURNING anchor_digest INTO v_prev;
            v_written := v_written + 1;
            v_day := v_day + 1;
        END LOOP;
    END LOOP;
    RETURN v_written;
END;
$$ LANGUAGE plpgsql;

-- Every anchored day whose rows or chain no longer match. Empty = intact.
CREATE FUNCTION verify_integrity()
RETURNS TABLE (table_name TEXT, day DATE, problem TEXT) AS $$
DECLARE
    a       RECORD;
    v_prev  BYTEA;
    v_tbl   TEXT := NULL;
    v_count BIGINT;
    v_rows  BYTEA;
BEGIN
    FOR a IN SELECT * FROM integrity_anchors ORDER BY integrity_anchors.table_name, integrity_anchors.day LOOP
        IF v_tbl IS DISTINCT FROM a.table_name THEN
            v_tbl := a.table_name;
            v_prev := NULL;
        END IF;
        SELECT d.row_count, d.digest INTO v_count, v_rows FROM integrity_rows_digest(a.table_name, a.day) d;
        IF v_count <> a.row_count OR v_rows <> a.rows_digest THEN
            table_name := a.table_name; day := a.day;
            problem := format('rows changed: anchored %s rows, now %s rows with a different digest', a.row_count, v_count);
            RETURN NEXT;
        END IF;
        IF a.prev_anchor_digest IS DISTINCT FROM v_prev
           OR a.anchor_digest <> integrity_anchor_digest(a.table_name, a.day, a.row_count, a.rows_digest, a.prev_anchor_digest) THEN
            table_name := a.table_name; day := a.day;
            problem := 'anchor chain broken';
            RETURN NEXT;
        END IF;
        v_prev := a.anchor_digest;
    END LOOP;
END;
$$ LANGUAGE plpgsql STABLE;
