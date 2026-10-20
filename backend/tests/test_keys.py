import hashlib
import stat

import pytest

from app import keys, tokens


def test_fill_missing_keeps_existing_values_and_adds_the_rest(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# comment\nBAYORA_TOKEN_OPERATOR=existing-operator-token\nBAYORA_TOKEN_RED=legacy\n")
    added = keys.fill_missing(env)
    _, values = keys.read(env)
    assert "BAYORA_TOKEN_OPERATOR" not in added
    assert values["BAYORA_TOKEN_OPERATOR"] == "existing-operator-token"
    assert values["BAYORA_TOKEN_RED"] == "legacy"  # left for the person to delete
    assert values["BAYORA_OPERATOR_TOKEN_SHA256"] == hashlib.sha256(b"existing-operator-token").hexdigest()
    for role in ("CP", "RED", "BLUE"):
        monkeypatch.setenv("SIGNING", values[f"BAYORA_{role}_SIGNING_KEY"])
        monkeypatch.setenv("PUBLIC", values[f"BAYORA_{role}_PUBLIC_KEYS"])
        kid, private = tokens.private_key("SIGNING")
        assert tokens.verify(tokens.sign({"x": 1}, kid, private), tokens.public_keys("PUBLIC"))["x"] == 1
    assert env.read_text().startswith("# comment\n")
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert keys.fill_missing(env) == []  # second run changes nothing


def test_a_stale_operator_hash_is_refused_not_overwritten(tmp_path):
    env = tmp_path / ".env"
    env.write_text("BAYORA_TOKEN_OPERATOR=a\nBAYORA_OPERATOR_TOKEN_SHA256=" + "0" * 64 + "\n")
    with pytest.raises(SystemExit):
        keys.fill_missing(env)
    assert "0" * 64 in env.read_text()


def test_rotation_replaces_the_signing_key_and_keeps_the_old_public_key(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    keys.fill_missing(env)
    _, before = keys.read(env)
    new_kid = keys.rotate(env, "red")
    _, after = keys.read(env)
    assert after["BAYORA_RED_SIGNING_KEY"] != before["BAYORA_RED_SIGNING_KEY"]
    assert after["BAYORA_RED_SIGNING_KEY"].startswith(f"{new_kid}:")
    assert after["BAYORA_RED_PUBLIC_KEYS"].endswith("," + before["BAYORA_RED_PUBLIC_KEYS"])
    assert after["BAYORA_BLUE_SIGNING_KEY"] == before["BAYORA_BLUE_SIGNING_KEY"]
    monkeypatch.setenv("BAYORA_RED_PUBLIC_KEYS", after["BAYORA_RED_PUBLIC_KEYS"])
    assert len(tokens.public_keys("BAYORA_RED_PUBLIC_KEYS")) == 2
