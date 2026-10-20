"""Database least privilege, checked against what PostgreSQL actually enforces.

Runs only with TEST_DATABASE_URL (a PostgreSQL database the test user owns as superuser).
Creates the cluster-wide role bayora_app_test, separate from the real bayora_app.
"""

import os
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from conftest import auth, run_to_completion

from app import db

TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL.startswith("postgres"), reason="needs TEST_DATABASE_URL")

ROLE = "bayora_app_test"
PASSWORD = "test-app-password-" + "x" * 16


def as_role(url: str) -> str:
    parts = urlsplit(url)
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit(parts._replace(netloc=f"{ROLE}:{PASSWORD}@{host}"))


@pytest.fixture
def migrated(client):
    from app import migrate

    migrate.migrate(PASSWORD, role=ROLE)
    migrate.migrate(PASSWORD, role=ROLE)  # idempotent
    return migrate


def refused(url: str, statement: str) -> str:
    with psycopg.connect(url) as conn, pytest.raises(psycopg.Error) as exc:
        conn.execute(statement)
    return str(exc.value)


def test_runtime_role_holds_exactly_the_planned_grants(migrated):
    with db.connect() as conn:
        grants = migrated.table_grants(conn, ROLE)
        role = conn.one(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication "
            "FROM pg_roles WHERE rolname = ?",
            (ROLE,),
        )
        can_create = conn.one(
            "SELECT has_schema_privilege(?, 'public', 'CREATE') AS ok, "
            "has_database_privilege(?, current_database(), 'CREATE') AS db_ok",
            (ROLE, ROLE),
        )
    assert grants == {table: set(privs) for table, privs in migrated.GRANTS.items()}
    assert not any(role.values()), role
    assert not can_create["ok"] and not can_create["db_ok"]


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE audit_events SET details = '{}'",
        "DELETE FROM audit_events",
        "TRUNCATE audit_events",
        "DELETE FROM sessions",
        "UPDATE defenses SET rule_id = 'x'",
        "DELETE FROM credential_revocations",
        "CREATE TABLE sneaky (id int)",
        "ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only",
        "DROP TRIGGER audit_events_append_only ON audit_events",
    ],
)
def test_runtime_role_cannot_rewrite_history_or_change_schema(migrated, statement):
    message = refused(as_role(TEST_URL), statement)
    assert "permission denied" in message or "must be owner" in message, message


def test_append_only_trigger_also_stops_the_owner(migrated, agents, client):
    run_to_completion(client, ["PI-01"])
    assert "append-only" in refused(TEST_URL, "UPDATE audit_events SET details = '{}'")
    assert "append-only" in refused(TEST_URL, "DELETE FROM audit_events")
    assert "append-only" in refused(TEST_URL, "TRUNCATE audit_events")


def test_full_run_works_as_the_runtime_role(migrated, agents, client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", as_role(TEST_URL))
    run = run_to_completion(client)
    assert run["next_stage"] is None and run["report"]
    revoke = client.post(
        "/api/credentials/revocations",
        json={"kid": "red-test", "reason": "rotation drill"},
        headers=auth("operator"),
    )
    assert revoke.status_code == 201
    assert client.get("/api/audit/verify", headers=auth("operator")).json()["ok"] is True
    controls = {c["name"]: c for c in client.get("/api/meta", headers=auth("operator")).json()["controls"]}
    least = controls["Database least privilege"]
    assert least["status"] == "implemented" and "trigger active" in least["detail"], least
