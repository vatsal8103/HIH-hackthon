"""Create the Docker secrets .env is missing, or rotate one role's signing key.

    uv run python -m app.keys ../.env               # add missing values; never changes existing ones
    uv run python -m app.keys ../.env --rotate red  # new key for red (or blue, cp); old public key kept

Rotation keeps the old public key in the role's PUBLIC_KEYS list, so requests already in
flight and historical audit evidence still verify. Afterwards: recreate the affected
containers, then revoke the old key id (POST /api/credentials/revocations) so it can no
longer authorise new requests. Values are written to the file only, never printed.
"""

import argparse
import hashlib
import os
import secrets
import sys
from datetime import UTC, datetime
from pathlib import Path

from app import tokens

RANDOM = ("POSTGRES_PASSWORD", "BAYORA_TOKEN_OPERATOR", "BAYORA_WITNESS_TOKEN", "BAYORA_APP_DB_PASSWORD")
KEYPAIRS = ("cp", "red", "blue")
UNUSED = ("BAYORA_TOKEN_RED", "BAYORA_TOKEN_BLUE", "BAYORA_TOKEN_TARGET")  # superseded by signed keys


def read(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text().splitlines() if path.exists() else []
    values = {}
    for line in lines:
        name, sep, value = line.partition("=")
        if sep and not line.lstrip().startswith("#"):
            values[name.strip()] = value.strip()
    return lines, values


def write(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n")
    os.chmod(path, 0o600)


def _kid(role: str) -> str:
    return f"{role}-{datetime.now(UTC):%Y%m%d}-{secrets.token_hex(2)}"


def fill_missing(path: Path) -> list[str]:
    lines, values = read(path)
    added = {}
    for name in RANDOM:
        if not values.get(name):
            added[name] = secrets.token_urlsafe(32)
    for role in KEYPAIRS:
        prefix = f"BAYORA_{role.upper()}"
        if not values.get(f"{prefix}_SIGNING_KEY"):
            private, public = tokens.generate(_kid(role))
            added[f"{prefix}_SIGNING_KEY"] = private
            added[f"{prefix}_PUBLIC_KEYS"] = public
    operator = values.get("BAYORA_TOKEN_OPERATOR") or added["BAYORA_TOKEN_OPERATOR"]
    digest = hashlib.sha256(operator.encode()).hexdigest()
    if values.get("BAYORA_OPERATOR_TOKEN_SHA256", digest) != digest:
        raise SystemExit("BAYORA_OPERATOR_TOKEN_SHA256 does not match BAYORA_TOKEN_OPERATOR; fix it by hand")
    if "BAYORA_OPERATOR_TOKEN_SHA256" not in values:
        added["BAYORA_OPERATOR_TOKEN_SHA256"] = digest
    write(path, lines + [f"{name}={value}" for name, value in added.items()])
    return list(added)


def rotate(path: Path, role: str) -> str:
    lines, values = read(path)
    prefix = f"BAYORA_{role.upper()}"
    old = values.get(f"{prefix}_PUBLIC_KEYS")
    if not old:
        raise SystemExit(f"{prefix}_PUBLIC_KEYS is not set; run without --rotate first")
    private, public = tokens.generate(_kid(role))
    replace = {f"{prefix}_SIGNING_KEY": private, f"{prefix}_PUBLIC_KEYS": f"{public},{old}"}
    write(
        path,
        [
            f"{line.partition('=')[0]}={replace[line.partition('=')[0]]}"
            if line.partition("=")[0] in replace
            else line
            for line in lines
        ],
    )
    return public.split(":")[0]


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("env_file", type=Path)
    parser.add_argument("--rotate", choices=KEYPAIRS)
    args = parser.parse_args(argv)
    if args.rotate:
        kid = rotate(args.env_file, args.rotate)
        print(f"New {args.rotate} key id {kid}. Recreate the containers, then revoke the old key id.")
        return
    added = fill_missing(args.env_file)
    print("Added: " + (", ".join(added) if added else "nothing (all values present)"))
    _, values = read(args.env_file)
    if leftover := [name for name in UNUSED if name in values]:
        print("No longer used by the Docker stack (safe to delete by hand): " + ", ".join(leftover))


if __name__ == "__main__":
    main(sys.argv[1:])
