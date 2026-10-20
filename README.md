# Bayora

A secure AI red-teaming laboratory, built for Hack in Hills '26, Track 4: Securing Adversarial AI Safety Testing Infrastructure.

Bayora tests two things at once:

1. **Does the target AI follow its safety policy?** Controlled attacks, explicit criteria, a defense, then a retest.
2. **Does the testing infrastructure protect itself?** Red Team, Target and Blue Team run with separate credentials. In the Docker stack they also run in separate containers on separate networks. Every action goes into a hash-linked audit chain, which an external witness checkpoints.

```
Create test → Red Team attack → Target response → Safety evaluation → Blue Team defense
           → Retest → Isolation checks → Audit evidence → Residual risk report
```

## What is real, simulated and planned

"Docker" means the `docker compose` stack; "dev" means the two local processes below.

| Control | Status | How it is checked |
|---|---|---|
| Role-scoped API permissions (one permission per route) | **Implemented** (dev + Docker) | Unit tests; 40 live probes per run; calls from inside each container |
| Red and Blue sign each request with their own Ed25519 key (60 s, one-time, session-bound, inside a 120 s control-plane grant); the control plane holds only their public keys, the operator token only as a hash | **Implemented** (Docker; dev uses static tokens) | Unit tests (replay, expiry, scope, revocation); in-container tests, including the control plane trying to sign as Red |
| Credential revocation and key rotation | **Implemented** (Docker) | `POST /api/credentials/revocations`; `app.keys --rotate`; unit tests |
| Runtime database role `bayora_app`: exact grants, no update/delete/truncate on audit events, append-only trigger | **Implemented** (Docker) | Grants read from PostgreSQL, refused statements, in `test_migrate.py` and `tests_compose/` |
| Blue Team sees redacted findings only; Target sees pending prompt text only | **Implemented** (dev + Docker) | Unit tests; data-level checks per run |
| Red, Blue and Target in separate containers with only their own credential | **Implemented** (Docker only; dev runs them in-process) | `docker inspect` and `/proc` checks in `tests_compose/` |
| One internal network per role path; agents reach only the control plane; no egress | **Implemented** (Docker only) | TCP probes by name and by every container IP, from outside (`tests_compose/`) and from inside each agent per run |
| Non-root, read-only, all capabilities dropped, `no-new-privileges`, resource limits | **Implemented** (Docker) | `tests_compose/` (Postgres keeps 5 capabilities to initialise its data dir) |
| Operator credential kept out of the browser bundle | **Implemented** (dev + Docker) | Bundle, image, env and log scans in `tests_compose/` |
| Hash-linked audit log (edits, deletions, reordering, evidence drift) | **Implemented** | Unit tests with real database tampering |
| External audit checkpoint (witness service) with extension proofs | **Implemented** (Docker; optional in dev) | Rewrite, truncation, deletion, outage, far-future and forged-proof tests, including a full owner rewrite in Docker |
| Witness recovery that never deletes (append-only `supersede` records; verification stays red) | **Implemented** (Docker) | Unit tests and the CLI run inside the witness container |
| Target model | **Simulated**: deterministic rules, not an LLM | Provider interface ready; no real provider implemented |
| Blue Team agent | **Simulated**: a fixed playbook from violated criterion to rule | |
| Per-user operator identity; shared jti cache across API restarts | **Planned** | |
| Kernel-level sandbox (gVisor, microVM) | **Planned**: containers share the Docker VM kernel | |

## Run with Docker (isolated roles)

Needs Docker with Compose v2 (tested on Docker Desktop 28.3.3, macOS arm64).

```bash
# once (and after upgrading): add any missing secrets and keys to .env (git-ignored, mode 600).
# Never changes existing values; compose refuses to start without them.
(cd backend && uv sync --extra postgres && uv run python -m app.keys ../.env)

docker compose up -d --build     # start: UI on http://127.0.0.1:8080 (loopback only)
docker compose ps -a             # edge-relay frontend backend db red-agent blue-agent target witness, migrate (exited 0)
docker compose logs -f backend   # follow the control plane
docker compose down              # stop and remove containers; keeps the database and witness volumes
docker compose down -v           # also delete all Docker data (sessions, audit chain, checkpoints)
```

Topology (all networks except `public` are internal, with no outside connectivity):

```
browser ──public──▶ edge-relay ──ui_net──▶ frontend (nginx) ──edge──▶ backend ──data──▶ db
                   (no credential)        (operator token)          │           ▲
                                                                    │   migrate (one-shot, owner password)
                                                                    ├──red_net──────▶ red-agent    (Red signing key)
                                                                    ├──blue_net─────▶ blue-agent   (Blue signing key)
                                                                    ├──target_net───▶ target       (CP public key only)
                                                                    └──witness_net──▶ witness      (own volume)
```

**Operations** (Docker):

```bash
# Revoke a key id at once (e.g. suspected compromise); recorded in the audit chain
curl -s -X POST 127.0.0.1:8080/api/credentials/revocations -H "Content-Type: application/json" \
  -d '{"kid":"<kid>","reason":"suspected compromise"}'

# Rotate a role key: new key in .env (old public key kept), recreate, then revoke the old kid
(cd backend && uv run python -m app.keys ../.env --rotate red) && docker compose up -d

# Witness recovery when publishing is "rejected" (a conflicting or far-future checkpoint).
# Appends a supersede record with your reason; nothing is deleted, and verification keeps reporting it.
docker compose exec witness .venv/bin/python -m witness.recover status
docker compose exec witness .venv/bin/python -m witness.recover supersede \
  --from-index <N> --expect-head-seq <current head seq> --reason "<what happened>"
```

## Run locally without Docker (in-process roles)

Needs Python 3.11+ with [uv](https://docs.astral.sh/uv/) and Node 20.19+ (tested with Python 3.13.7, uv 0.12.5 and Node 24.5).

```bash
# 1. API on http://127.0.0.1:8000 (SQLite file backend/bayora.db by default; dev tokens)
cd backend
uv sync --extra postgres
uv run uvicorn app.main:app --port 8000

# 2. UI on http://127.0.0.1:5173 (second terminal). The Vite proxy injects the operator token.
cd frontend
npm install
npm run dev
```

Stop either with Ctrl-C. In this mode the roles run inside the API process. The UI says so ("Roles: in-process", "Anchor: none"), and the isolation checks are labelled simulated or planned.

**PostgreSQL instead of SQLite:** `createdb bayora`, then start the API with `DATABASE_URL="postgresql:///bayora?host=/tmp"`.

**Optional local witness:**

```bash
cd backend
export BAYORA_WITNESS_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
BAYORA_WITNESS_DATA=./.witness uv run uvicorn witness.app:app --port 8100 &
BAYORA_WITNESS_URL=http://127.0.0.1:8100 uv run uvicorn app.main:app --port 8000
```

Locally, the witness only checks the chain's history; it is not isolated from the API's user account.

## Tests and checks

```bash
cd backend
uv run pytest                     # 102 unit tests on SQLite (12 PostgreSQL-only tests skip)
TEST_DATABASE_URL="postgresql:///bayora_test?host=/tmp" uv run pytest   # all 114 on PostgreSQL (needs a superuser; creates role bayora_app_test)
uv run ruff check . && uv run ruff format --check .

cd ..
./scripts/compose-test.sh         # 61 container/network tests on a throwaway stack (bayora-test, port 18080)

cd frontend
npm run build                     # TypeScript strict check + production build
```

`compose-test.sh` builds a separate Compose project, runs `backend/tests_compose/` against it, and removes it and its volumes afterwards. It never touches the main `bayora` stack.

## Using the role interfaces directly (dev mode)

```bash
RUN=$(curl -s -X POST localhost:8000/api/runs -H "Authorization: Bearer dev-operator-token" \
  -H "Content-Type: application/json" -d '{"attack_ids":["PI-01"]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:8000/api/runs/$RUN/advance -H "Authorization: Bearer dev-operator-token" > /dev/null  # attack stage

curl -s localhost:8000/api/red/sessions/$RUN/attempts -H "Authorization: Bearer dev-blue-token"   # 403: Blue cannot read Red
curl -s localhost:8000/api/target/sessions/$RUN/inbox -H "Authorization: Bearer dev-target-token" # pending prompt text only
```

In Docker these static role tokens do not exist: Red and Blue must sign requests, and the target has no credential. The API is not published at all. The edge proxy answers only for `127.0.0.1` or `localhost` (DNS-rebinding protection), acts only as the operator, and refuses `/api/red|blue|target/`. The API itself also rejects unknown `Host` headers (`BAYORA_ALLOWED_HOSTS`).

## Project layout

```
backend/app/
  main.py        routes (one permission each), control register, checkpoint publishing
  auth.py        permission table, signed and bearer credential checks, startup validation
  tokens.py      Ed25519 compact tokens (also copied into the agent image)
  credentials.py control-plane grants, signed-request verification, revocation
  keys.py        .env secret bootstrap and key rotation (CLI)
  migrate.py     PostgreSQL schema, runtime role and audit trigger (one-shot)
  pipeline.py    session state machine; in-process or agent-backed role stages
  remote.py      outbound calls to agents and the witness (failures raise, never fall back)
  checkpoint.py  publish the chain head to the witness; verify the chain against it
  providers.py   target model provider interface (simulator only)
  isolation.py   permission probes, data checks, agent network/container checks
  audit.py       hash chain, verification and tamper simulation
  attacks.py · target.py · defenses.py · evaluator.py · db.py
backend/agents/  red_agent.py · blue_agent.py · target_agent.py · common.py
backend/witness/ app.py (append-only checkpoint log, extension proofs) · recover.py (supersede CLI)
backend/tests/          unit tests          backend/tests_compose/  container and network tests
frontend/src/
  lab.tsx        run controller: advances the backend one stage at a time
  scene/         3D security lattice (React Three Fiber) and its SVG fallback
  pages/         Overview, Test runs, Attack library, Isolation lab, Audit trail, Risk reports
```

[flow.md](flow.md) traces execution end to end. [descision.md](descision.md) records why things are built the way they are.
