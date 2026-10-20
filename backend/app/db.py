"""Storage: SQLite file by default, PostgreSQL when DATABASE_URL is a postgres URL.

SQL is written once with `?` placeholders and plain TEXT/INTEGER columns so both
engines accept it. JSON values are stored as TEXT.
"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DEFAULT_URL = f"sqlite:///{Path(__file__).resolve().parent.parent / 'bayora.db'}"

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        stage TEXT NOT NULL,
        attack_ids TEXT NOT NULL,
        report TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        position INTEGER NOT NULL,
        attack_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT,
        blocked_by TEXT,
        filtered_by TEXT,
        transformed_by TEXT,
        verdict TEXT,
        criteria TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS defenses (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        position INTEGER NOT NULL,
        rule_id TEXT NOT NULL,
        criterion TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS isolation_checks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        position INTEGER NOT NULL,
        check_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        session_id TEXT,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        evidence_ref TEXT,
        details TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
    )""",
]


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


def engine() -> str:
    return "postgresql" if database_url().startswith("postgres") else "sqlite"


class DB:
    def __init__(self, conn, is_pg: bool):
        self.conn = conn
        self.is_pg = is_pg

    def execute(self, sql: str, params: tuple = ()):
        if self.is_pg:
            sql = sql.replace("?", "%s")
        return self.conn.execute(sql, params)

    def all(self, sql: str, params: tuple = ()) -> list[dict]:
        return list(self.execute(sql, params).fetchall())

    def one(self, sql: str, params: tuple = ()) -> dict | None:
        return self.execute(sql, params).fetchone()

    def lock_audit(self) -> None:
        """Serialise audit appends until this transaction commits."""
        if self.is_pg:
            self.conn.execute("LOCK TABLE audit_events IN EXCLUSIVE MODE")
        elif not self.conn.in_transaction:
            self.conn.execute("BEGIN IMMEDIATE")


def _dict_row(cursor, row):
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


def _open() -> DB:
    url = database_url()
    if url.startswith("postgres"):
        import psycopg  # optional dependency: `uv sync --extra postgres`
        from psycopg.rows import dict_row

        return DB(psycopg.connect(url, row_factory=dict_row), is_pg=True)
    conn = sqlite3.connect(url.removeprefix("sqlite:///"), timeout=10)
    conn.row_factory = _dict_row
    conn.execute("PRAGMA foreign_keys = ON")
    return DB(conn, is_pg=False)


@contextmanager
def connect():
    db = _open()
    try:
        yield db
        db.conn.commit()
    except BaseException:
        db.conn.rollback()
        raise
    finally:
        db.conn.close()


def init_db() -> None:
    with connect() as db:
        for statement in SCHEMA:
            db.execute(statement)
