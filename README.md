# Bayora

A secure AI red-teaming laboratory, built for Hack in Hills '26, Track 4: Securing Adversarial AI Safety Testing Infrastructure.

## In plain words

**Can your AI withstand an attack?** AI assistants follow instructions written in ordinary language, so anyone can try to talk them into breaking their rules: leaking confidential data, ignoring their instructions, or writing something they should refuse. Bayora attacks an AI on purpose, in a controlled lab, checks whether the defenses work, and keeps evidence of everything that happened.

Three roles take part:

- **Red Team, the tester.** Sends scripted, harmless attack prompts from the attack library at a fictional clinic assistant.
- **Target, the system under test.** Receives each prompt and answers it. By default it is a deterministic simulator (fixed rules, not a live AI model). Optional **Live AI mode** puts a real model in its place: local through Ollama (e.g. `qwen3:4b`), or hosted by Groq (e.g. `qwen/qwen3.8-27b`). The UI says which one answered, based on what the backend reports.
- **Blue Team, the defender.** Sees only a redacted summary of what failed (never the attack prompts) and adds protections: input guards and an output filter.

One test runs in seven recorded steps:

| Step | Plain name | What happens |
|---|---|---|
| 1 | Attack attempt | The Red Team sends the attack prompts |
| 2 | AI response | The target answers each one |
| 3 | Check the response | Each answer is checked against the written safety rules for its attack |
| 4 | Apply protection | The Blue Team adds protections for what failed |
| 5 | Try again | The same attacks run again; the two results are compared |
| 6 | Check the walls | Bayora checks that each role can reach only what it is allowed to |
| 7 | Score and record | The remaining risk is scored and the evidence record is verified |

Every step is written to a hash-linked audit record (each entry carries the previous entry's fingerprint, so edits, deletions and reordering are detected). In the Docker stack a separate witness service also keeps checkpoints, which catch even a complete rewrite of anything already checkpointed. Events after the latest checkpoint are not covered until the next one, and someone who controls both the database and the witness's storage could still alter both: this is tamper detection, not tamper-proofing.

Results use careful words: **Passed this test**, **Stopped by a protection**, **Hidden, not fixed** (an output filter removed the leak but the AI still tried), **Still vulnerable**, **Failed the retry**. A passed test means no failure was detected in that test, never that the AI is safe.

### Guided demo and presenter script

Open the UI, then **Guided demo** in the navigation (`#/demo`). It walks through six steps (the problem, the test, the result, the defense, the evidence, the conclusion) using the real data of the latest run, with a suggested sentence to say at each step. Each step is labelled with what it does: it explains, shows recorded data, can start a test (step 2) or runs a read-only check (step 5). If the latest run is missing, unfinished or does not include the chosen attack, the step says which, and offers to run that attack; this creates a new saved test session through the normal controls and deletes nothing. **How it works** (`#/how`) explains the roles, steps, evidence record and what is real or simulated in the deployment you are looking at.

**A repeatable demo sequence** (Docker, about four minutes):

1. **Overview** (`http://127.0.0.1:8080`): read the headline and the "Demo environment · Target behavior is simulated" notice. Press **Run a security test** and let the seven steps play (about 15 seconds; **Skip the animation** shortens it).
2. **The latest run** on the same page: the four numbers (attacks tested, passed on retest, still vulnerable, highest remaining risk), then **Needs attention**. Select a finding to explain it in the panel; its **Technical evidence** disclosure shows the recorded rule results.
3. **Guided demo**: step through 1–6 with the default attack PI-01, reading the "Say this" lines. In step 5 press **Verify the whole record now**.
4. **Risk reports**: the remaining issues, why each matters, and the next action.
5. **Audit trail**: the verification status at the top, then **Rewrite the chain** under Tamper simulation. The record's own links still verify, but the witness catches it. The stored record is never modified.
6. **Isolation lab**: **Run 40 live probes**; point out that the target, which holds no credential in Docker, is refused even where the permission table grants it access.

A 60 to 90 second script (also inside the demo page):

> AI assistants take instructions in plain language, so anyone can try to talk them into breaking their rules. Bayora is a lab that tests that safely.
>
> A Red Team sends scripted attacks: overriding instructions, role-play jailbreaks, hidden instructions in documents. The target answers, and every answer is checked against written safety rules.
>
> Then a Blue Team, which only sees a redacted summary, adds protections, and every attack runs again. So we can show which defenses actually helped, which only hid the problem, and what still fails.
>
> Everything is recorded in a hash-linked audit trail, and a separate witness keeps checkpoints, so changes to the record are detected. In the Docker version the roles run in separate containers and can only reach what they're allowed to.
>
> Today the target is a deterministic simulator, and we say so on screen. The point is the method: attack, measure, defend, retest, and keep the evidence.

## In technical terms

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
| Target model | **Simulated** by default; **live** model via Ollama (local) or Groq (hosted) when configured (Live AI mode) | Provider tests with mocked Ollama and Groq; real two-attack runs in Docker through `ollama-proxy` and `groq-proxy` |
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

**Another local API:** `BAYORA_DEV_API=http://127.0.0.1:8001 npx vite --port 5180` points the dev proxy at an API on another port (for example a throwaway one on an empty SQLite file). In dev mode `#/dev-crash` throws a deliberate render error to show the page-level error boundary; production builds do not include it.

**PostgreSQL instead of SQLite:** `createdb bayora`, then start the API with `DATABASE_URL="postgresql:///bayora?host=/tmp"`.

**Optional local witness:**

```bash
cd backend
export BAYORA_WITNESS_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")
BAYORA_WITNESS_DATA=./.witness uv run uvicorn witness.app:app --port 8100 &
BAYORA_WITNESS_URL=http://127.0.0.1:8100 uv run uvicorn app.main:app --port 8000
```

Locally, the witness only checks the chain's history; it is not isolated from the API's user account.

## Live AI mode (optional)

The default target is the simulator. Live AI mode replaces it with a model served by Ollama on your machine. Nothing falls back to the simulator: if the model fails, the step fails with the reason, and the UI says so before you start ("the model is not ready").

**What changes, and what does not.**
- **What the model sees:** the same synthetic clinic scenario the simulator encodes, as a system prompt. That includes a confidential canary token and patient record, so the leak checks can actually fail.
- **What stays the same:**
  - input guardrails and output filtering still run in the control plane
  - the target agent still checks the control-plane grant before calling the model
  - every target event in the audit trail records the provider (for example `ollama/qwen3:4b`, kind `live`), and so does each report
- **Reasoning:** for reasoning models, Ollama returns the reasoning separately (`think: true`); only the final answer is evaluated.

**Local dev (no Docker).** With Ollama running (`ollama serve`) and the model installed (`ollama pull qwen3:4b`):

```bash
cd backend
BAYORA_TARGET_PROVIDER=ollama uv run uvicorn app.main:app --port 8000   # Ollama defaults to http://127.0.0.1:11434
```

**Docker.** The target reaches Ollama only through `ollama-proxy`, an nginx container on an internal network (`ollama_net`) shared with nothing but the target. The proxy holds no credential, forwards only `POST /api/chat` and `GET /api/tags`, and returns 403 for everything else, including pull, delete, create and copy. Red, Blue and the backend have no path to it; the per-run isolation check (ISO-06) and `tests_compose/` both verify that. Add to `.env`:

```bash
BAYORA_TARGET_PROVIDER=ollama
BAYORA_TARGET_TIMEOUT=330        # control plane → target, per answer; above BAYORA_OLLAMA_TIMEOUT
# optional: BAYORA_OLLAMA_MODEL=qwen3:4b  BAYORA_OLLAMA_TIMEOUT=300
```

then `docker compose --profile live up -d --build`. To go back, remove those lines and run `docker compose up -d`; `docker compose --profile live stop ollama-proxy` stops the proxy.

**Settings** (environment of the process that runs the target):

| Variable | Default | Meaning |
|---|---|---|
| `BAYORA_TARGET_PROVIDER` | `simulator` | `simulator` or `ollama` |
| `BAYORA_OLLAMA_URL` | `http://127.0.0.1:11434` (Docker: `http://ollama-proxy:11434`) | Ollama base URL |
| `BAYORA_OLLAMA_MODEL` | `qwen3:4b` | Installed model name |
| `BAYORA_OLLAMA_THINK` | `true` | Separate reasoning; `false` for models without thinking (e.g. `llama3.2:3b`) |
| `BAYORA_OLLAMA_TIMEOUT` | `300` | Seconds per answer |
| `BAYORA_OLLAMA_MAX_TOKENS` | `6144` | Tokens per answer, reasoning included |
| `BAYORA_OLLAMA_CONTEXT` | `8192` | Context window (`num_ctx`) |
| `BAYORA_TARGET_TIMEOUT` | `20` | Control plane's wait for one target answer (backend env) |

**For a demo,** choose one or two attacks in the Attack library (PS-05 and PR-06 took 22 and 36 s per answer here); a full run with qwen3:4b takes 20 minutes or more. `llama3.2:3b` (with `BAYORA_OLLAMA_THINK=false`) is much faster but a different model.

### Groq (hosted)

`BAYORA_TARGET_PROVIDER=groq` uses a model hosted by Groq through its OpenAI-compatible API (default `qwen/qwen3.8-27b`, verified available to this account on 2026-10-21; about 0.3 to 1 s per answer).

**Data leaves your machine.** The attack prompts and the synthetic scenario (canary token, made-up patient record) are sent to Groq, a third party. The UI notice, the control register and each report say so.

**The key** is read from `GROQ_API_KEY` on the server side only. It is never sent to the browser and never written to errors, logs, `/api/meta`, reports or audit events; tests search all of those for it.
- **Docker:** only `groq-proxy` receives it. The target holds no key.
- **Local dev:** the API process sends it itself, over HTTPS only.

**Local dev:**

```bash
cd backend
export GROQ_API_KEY="$(grep '^GROQ_API_KEY=' ../.env | cut -d= -f2-)"   # this shell only; not echoed
BAYORA_TARGET_PROVIDER=groq uv run uvicorn app.main:app --port 8000
```

**Docker.** The target reaches Groq only through `groq-proxy`, an nginx container on an internal network (`groq_net`) shared with nothing but the target. The proxy:
- holds the key and adds it to each request
- forwards only `POST /openai/v1/chat/completions` and `GET /openai/v1/models`, and returns 403 for everything else (files, batches, embeddings, audio)
- verifies Groq's TLS certificate and connects only to `api.groq.com`
- refuses to start without a key

Red, Blue and the backend have no path to it (per-run ISO-06 and `tests_compose/`). Add to `.env`:

```bash
BAYORA_TARGET_PROVIDER=groq
BAYORA_TARGET_TIMEOUT=90
# GROQ_API_KEY=...            already present
# optional: BAYORA_GROQ_MODEL=qwen/qwen3.8-27b  BAYORA_GROQ_TIMEOUT=60
```

then `docker compose --profile groq up -d --build`. To go back, remove the first two lines and run `docker compose up -d`.

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | (none) | Groq key; Docker: groq-proxy only |
| `BAYORA_GROQ_MODEL` | `qwen/qwen3.8-27b` | Groq model id |
| `BAYORA_GROQ_URL` | `https://api.groq.com` (Docker: `http://groq-proxy:8080`) | API base URL |
| `BAYORA_GROQ_AUTH` | `key` (Docker: `proxy`) | Who adds the key: this process, or the proxy |
| `BAYORA_GROQ_TIMEOUT` | `60` | Seconds per answer |
| `BAYORA_GROQ_MAX_TOKENS` | `2048` | `max_completion_tokens` |
| `BAYORA_GROQ_REASONING_FORMAT` | `parsed` | `parsed` or `hidden` keep reasoning out of the answer; `none` omits the field |

Errors are explained and never replaced by another provider's answer: a rejected key (401), the rate limit (429, with the retry delay), other HTTP errors, a malformed reply, or a timeout.

## Tests and checks

```bash
cd backend
uv run pytest                     # 141 unit tests on SQLite (12 PostgreSQL-only tests skip)
TEST_DATABASE_URL="postgresql:///bayora_test?host=/tmp" uv run pytest   # all 153 on PostgreSQL (needs a superuser; creates role bayora_app_test)
uv run ruff check . && uv run ruff format --check .

cd ..
./scripts/compose-test.sh         # 61 container/network tests on a throwaway stack (bayora-test, port 18080)
COMPOSE_PROFILES=live ./scripts/compose-test.sh   # also the 3 ollama-proxy tests (64)
COMPOSE_PROFILES=groq ./scripts/compose-test.sh   # also the 3 groq-proxy tests (64; one makes a read-only call to Groq)

cd frontend
npm run build                     # TypeScript strict check + production build
npm test                          # 20 tests: plain-language rules and API error handling (Node's built-in test runner)
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

## Known limitations and caveats

- **By default the target is a simulator.** It follows fixed rules, so results show how the method works, not how a real model behaves; the UI shows "Demo environment" because `/api/meta` reports `target.kind: simulated`.
- **Live AI mode is slow and only heuristically evaluated.** qwen3:4b reasons at length: 22 to 244 seconds per answer on an M3, about 20 to 25 minutes for a full seven-attack run. Its answers can vary between runs (temperature 0 and a fixed seed reduce, not remove, variation). The evaluator's exact-string checks miss paraphrased, partial or encoded leaks, and count a refusal only if it opens with the scenario's refusal sentence. Reasoning text is not evaluated.
- **The Blue Team is a fixed playbook,** mapping each failed rule to one protection.
- **Seven scripted attacks are not a security audit.** A passed test shows that one attack failed here, nothing about attacks that were not tried.
- **Dev mode is weaker than Docker.** Locally the roles run inside the API process, there is no witness unless you start one, and the UI says so (Roles: in-process, Anchor: none, and the isolation checks marked simulated or planned). Container, network, credential and database-privilege controls exist only in the Docker stack.
- **Tamper detection has limits.** Events after the latest witness checkpoint are not covered yet, and whoever controls both the database owner role and the witness volume could alter both.
- **Containers share one kernel** (the Docker Desktop VM); there is no gVisor or microVM sandbox.
- **Per-user identity is not implemented.** The operator is one shared credential, injected by the proxy.
- The security review's residual risks and the threat model are in `descision.md`; the execution path is in `flow.md`.

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
  explain.ts     plain-language reading of recorded results (unit-tested; never says more than the data)
  scene/         3D security lattice (React Three Fiber) and its SVG fallback
  pages/         Overview, How it works, Guided demo, Test runs, Attack library, Isolation lab, Audit trail, Risk reports
```

[flow.md](flow.md) traces execution end to end. [descision.md](descision.md) records why things are built the way they are.
