"""Schema, runtime role and audit protection for PostgreSQL. Idempotent; run once per deploy.

    DATABASE_URL=<owner url> BAYORA_APP_DB_PASSWORD=... python -m app.migrate

In Docker the one-shot `migrate` service runs this with the database owner's credentials,
then exits; the API connects as `bayora_app` and never holds the owner's password. The
runtime role gets exactly the privileges the routes use (GRANTS), cannot create objects,
and cannot update, delete or truncate audit events. A trigger refuses those operations on
audit_events for every role, so even the owner must disable it deliberately (an action
PostgreSQL logs as DDL) before altering history.

What this does not stop: the owner or a superuser can still disable the trigger and rewrite
rows. That is why the audit chain is also checkpointed to the witness.
"""

import os

from psycopg import sql

from app import db

APP_ROLE = "bayora_app"

# Exactly what app/ issues per table (see the INSERT/UPDATE statements in pipeline.py,
# isolation.py, audit.py and main.py). Nothing is ever deleted at runtime.
GRANTS = {
    "sessions": ("SELECT", "INSERT", "UPDATE"),
    "attempts": ("SELECT", "INSERT", "UPDATE"),
    "defenses": ("SELECT", "INSERT"),
    "isolation_checks": ("SELECT", "INSERT"),
    "audit_events": ("SELECT", "INSERT"),
    "credential_revocations": ("SELECT", "INSERT"),
}

AUDIT_GUARD = """
CREATE OR REPLACE FUNCTION bayora_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$
"""


def migrate(app_password: str, role: str = APP_ROLE) -> None:
    db.init_db()
    with db.connect() as conn:
        if not conn.is_pg:
            raise SystemExit("app.migrate manages PostgreSQL roles; SQLite needs no migration step")
        ident = sql.Identifier(role)
        attrs = sql.SQL(
            "LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS "
            "CONNECTION LIMIT 20"
        ).format(sql.Literal(app_password))
        exists = conn.one("SELECT 1 AS ok FROM pg_roles WHERE rolname = %s", (role,))
        verb = "ALTER" if exists else "CREATE"  # ALTER also rotates the password
        conn.conn.execute(sql.SQL(verb + " ROLE {} WITH ").format(ident) + attrs)
        database = sql.Identifier(conn.one("SELECT current_database() AS name")["name"])
        conn.conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(database, ident))
        conn.conn.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
        conn.conn.execute(sql.SQL("REVOKE CREATE ON SCHEMA public FROM {}").format(ident))
        conn.conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(ident))
        for table, privileges in GRANTS.items():
            table_ident = sql.Identifier(table)
            conn.conn.execute(sql.SQL("REVOKE ALL ON {} FROM PUBLIC, {}").format(table_ident, ident))
            conn.conn.execute(
                sql.SQL("GRANT {} ON {} TO {}").format(
                    sql.SQL(", ").join(map(sql.SQL, privileges)), table_ident, ident
                )
            )
        conn.conn.execute(AUDIT_GUARD)
        conn.conn.execute(
            "CREATE OR REPLACE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events "
            "FOR EACH ROW EXECUTE FUNCTION bayora_audit_append_only()"
        )
        conn.conn.execute(
            "CREATE OR REPLACE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events "
            "FOR EACH STATEMENT EXECUTE FUNCTION bayora_audit_append_only()"
        )


def table_grants(conn: db.DB, role: str = APP_ROLE) -> dict[str, set[str]]:
    """The privileges `role` actually holds on each public table, as PostgreSQL reports them."""
    grants: dict[str, set[str]] = {}
    for row in conn.all(
        "SELECT table_name, privilege_type FROM information_schema.role_table_grants "
        "WHERE grantee = ? AND table_schema = 'public'",
        (role,),
    ):
        grants.setdefault(row["table_name"], set()).add(row["privilege_type"])
    return grants


if __name__ == "__main__":
    password = os.environ.get("BAYORA_APP_DB_PASSWORD", "")
    if len(password) < 24:
        raise SystemExit("BAYORA_APP_DB_PASSWORD must be set (24+ characters)")
    migrate(password)
    print(f"Schema and role {APP_ROLE} are up to date.")
