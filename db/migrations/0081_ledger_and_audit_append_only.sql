-- #68: ledger_entries was editable as long as each entry group stayed
-- balanced. ARCHITECTURE: corrections are new entries, never edits.
-- #67: admin_audit_log had no protection at all (the "trigger in 0034" a
-- comment refers to never existed), and it didn't record the role an admin
-- held when they acted.

CREATE FUNCTION reject_ledger_entry_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: post a correcting entry instead of % on row %', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entry_change();

ALTER TABLE admin_audit_log ADD COLUMN admin_role TEXT;

CREATE FUNCTION guard_admin_audit_log_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'admin_audit_log is append-only: rows cannot be deleted';
    END IF;
    -- Only the outcome of an action and its metadata may be filled in later
    -- (markAdminAuditOutcome); who did what, to what, and when never change.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.admin_user_id IS DISTINCT FROM OLD.admin_user_id
       OR NEW.admin_role IS DISTINCT FROM OLD.admin_role
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'admin_audit_log: only outcome and metadata may be updated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admin_audit_log_append_only
    BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION guard_admin_audit_log_change();
