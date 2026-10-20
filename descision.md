# Decision Log

Records meaningful engineering decisions for this project, per `AGENTS.md`.
Newest entries go at the bottom. When a decision changes, add a new entry and mark the old one as superseded instead of rewriting it.

Each entry separates **Observed** (verifiable in the repo) from **Inferred** (reasoning not stated anywhere in the repo). Do not record reasoning that is neither observed nor stated by the user.
Entries written at the time a decision is made record that reasoning directly as **Rationale**. Requirements that come from the user's brief are marked **Stated by user**.

## Entry template

```
## YYYY-MM-DD — <short title>
- Status: Active | Superseded by <entry>
- Decision: what was chosen
- Reason: why (mark Observed / Inferred / Stated by user)
- Approach: how it was implemented
- Files / components / technologies: what is involved and why
- Alternatives considered: and why they were rejected (if relevant)
- Trade-offs: costs and risks accepted
- Verification: checks actually run, with results
```

---

## 2026-10-20 — Baseline: repository state when documentation was established
- Status: Superseded by "First vertical slice: stack and versions" (same day). Kept as the record of the empty starting point.
- Decision: None yet. No implementation, architecture, or dependency decisions exist to record.
- Observed: The repository contains only `AGENTS.md`, `descision.md`, and `flow.md`. No source code, package manifests, configuration, tests, or entry points are present. The directory is not a git repository, so no history is available.
- Inferred: None. No historical reasoning can be inferred from an empty codebase.
- Verification: Listed every file in the project root, including hidden files (`ls -la`). No tests or checks exist to run.

## 2026-10-20 — Project documentation and workflow conventions
- Status: Active
- Decision: Keep two root-level docs, `descision.md` (decision log) and `flow.md` (execution flow), and update them alongside meaningful code changes.
- Reason (Observed): Required by `AGENTS.md`, which also requires a simplicity-first workflow ("Ponytail's simplicity-first rules"), running relevant checks, and reviewing diffs.
- Approach: Plain Markdown files at the repo root. `flow.md` uses numbered steps and Mermaid diagrams once there is code to trace.
- Files: `AGENTS.md` (rules), `descision.md`, `flow.md`.
- Notes:
  - The filename `descision.md` keeps the spelling used in `AGENTS.md`. Renaming it would break the reference in the rules file.
  - Only the rules-file integration is present. No Ponytail commands, hooks, or tooling are installed in this repository.
- Trade-offs: Manual upkeep. The docs can drift from the code if they are not updated with each change.

---

# First vertical slice (2026-10-20)

Built from the "Bayora master build prompt" and the "Mandatory visual quality direction" briefs. The following are **Stated by user**: the product mission, the workflow, distinct role permissions, the stack (React, TypeScript, Tailwind, FastAPI, PostgreSQL where practical, Docker), React Three Fiber for 3D, honest labelling of simulated controls, and the visual direction.

## 2026-10-20 — First vertical slice: stack and versions
- Status: Active
- Decision: Backend on FastAPI (0.150) under Python 3.13, managed with uv, with ruff as its only dev tool besides pytest. Frontend on Vite 8.3.4, React 19.3.1, TypeScript 5.9.3, Tailwind 4.3.3 and React Three Fiber 9.8.2 with three 0.186.1. Exact versions are pinned in `frontend/package.json`.
- Rationale: These are the stack the user asked for, at the versions installed or published when the work was done (checked with `npm view`, `pip index` and `uv`). React Three Fiber 9.8.2 declares `react >=19 <19.4`, which React 19.3.1 satisfies.
- Alternatives considered:
  - TypeScript 7.0.2, the newest major and a native port, was rejected to avoid toolchain risk in a time-boxed build; 5.9.3 is mature.
  - `@react-three/drei` was rejected: the scene needs only core geometry, materials and three's bundled `RoomEnvironment`, so drei would add weight for no benefit.
  - ESLint was skipped to avoid a plugin dependency tree; strict `tsc` is the frontend check.
- Trade-offs: No frontend lint rules beyond the type checker. `.python-version` pins 3.13 because uv otherwise chose its managed 3.14.
- Verification: `uv sync`, `npm install` (0 vulnerabilities reported), `tsc --noEmit`, `vite build`.

## 2026-10-20 — Storage: SQLite by default, PostgreSQL through DATABASE_URL
- Status: Active
- Decision: Use one small wrapper (`backend/app/db.py`) with SQL written once using `?` placeholders. It uses stdlib `sqlite3` by default and switches to `psycopg` 3 when `DATABASE_URL` starts with `postgres`. Schema setup is `CREATE TABLE IF NOT EXISTS` at startup.
- Rationale: The user asked for PostgreSQL when it is practical locally. It is: Homebrew Postgres 14 was accepting connections. Keeping SQLite as the default means tests and a first run need no database server.
- Approach: `DB.execute` rewrites `?` to `%s` for psycopg. Rows are dicts on both engines. JSON is stored as TEXT. Every request opens a connection with `db.connect()`, which commits on success and rolls back on error. Audit appends are serialised with `DB.lock_audit()`: `BEGIN IMMEDIATE` on SQLite, `LOCK TABLE ... IN EXCLUSIVE MODE` on Postgres.
- Alternatives considered: SQLAlchemy was rejected as a large dependency for five tables. Postgres-only was rejected because every test run would need a database server.
- Trade-offs: No migrations. A schema change requires dropping the tables during prototyping. Ordering inside a session uses an explicit `position` column, added after `created_at` ties at millisecond resolution made ordering nondeterministic.
- Verification: The full pytest suite passes on both engines (21/21 on SQLite and 21/21 with `TEST_DATABASE_URL` pointing at local Postgres 14).

## 2026-10-20 — Pipeline as a staged state machine advanced one stage per request
- Status: Active
- Decision: A session moves through `created → attack → respond → evaluate → defend → retest → isolation → report`. `POST /api/runs` only creates the session, and each `POST /api/runs/{id}/advance` executes exactly one stage (`backend/app/pipeline.py`).
- Rationale: The brief requires the animation to reflect actual test state. With per-stage requests, the UI shows a stage only after the backend has executed it, and an interrupted run can be resumed.
- Alternatives considered:
  - Running the whole pipeline in one request and replaying it was rejected, because the animation would no longer correspond to backend state transitions.
  - A background job with polling was rejected as extra machinery: each stage takes milliseconds.
- Trade-offs: The UI's pacing (`STAGE_MS` in `frontend/src/lab.tsx`) is presentational, and the code says so. Seven round trips per run.
- Verification: `test_stage_by_stage_state_is_visible` asserts that responses are absent after the attack stage and verdicts are absent after the respond stage.

## 2026-10-20 — Role model: per-role bearer tokens and one permission table
- Status: Active
- Decision:
  - Four roles (`operator`, `red`, `blue`, `target`) get static tokens from `BAYORA_TOKEN_<ROLE>`, with dev defaults.
  - `auth.PERMISSIONS` is the single source of truth, and each route declares exactly one permission via `Depends(require(...))`.
  - Each role sees a scoped view of the data:
    - Red Team: its own prompts and outcomes, never which rule acted.
    - Blue Team: redacted findings (criterion, severity, masked excerpt), never prompts or attack ids.
    - Target: prompt text only.
    - Operator: a supervisor who can read everything for review.
- Rationale: The brief states that the frontend is not a security boundary, and that hidden Red Team state must not reach the Blue Team through unrestricted endpoints.
- Approach: The role views live in `pipeline.red_view`, `pipeline.blue_findings` and `pipeline.target_inbox`. The simulated Blue Team agent (`stage_defend`) decides only from `blue_findings`, the same data the Blue HTTP route returns.
- Alternatives considered: Real identity (OIDC or per-user accounts) is planned; it is out of scope for the slice. Re-checking permissions inside service functions was rejected as duplication: the HTTP layer is the enforcement point.
- Trade-offs: In-process code such as the orchestrator can call any service, so the boundary holds only at the HTTP interface. The operator token is baked into the frontend bundle, which is acceptable for a local lab and not for deployment.
- Verification: `test_permissions.py` covers cross-role 403s, 401s for missing or forged tokens, the scoped views, and a 40-probe permission matrix.

## 2026-10-20 — Deterministic simulated target, attack catalogue and evaluator
- Status: Active
- Decision:
  - **Target:** `target.model()` is fixed rules that reproduce known failure modes: literal override, persona escape, Base64-decoded instructions, hidden instructions in quoted documents, and assembled split payloads. It refuses one disallowed request.
  - **Attack catalogue:** seven synthetic cases against a fictional clinic assistant (`attacks.py`), including a benign control case.
  - **Evaluator:** five named criteria (`evaluator.py`).
- Rationale: The brief requires repeatable, deterministic results with meaningful successes and failures, and never presenting simulation as a real LLM. Secrets (canary token, patient record) are synthetic.
- Approach: The Blue Team playbook maps each violated criterion to one rule. Because Blue never sees the attack, it picks the literal `instruction-guard` for override findings. That deliberately leaves the encoded (OB-03) and split (PS-05) cases failing at retest. Residual risk scoring (`pipeline.residual_risk`):
  - still failing → the highest severity among the failed criteria
  - blocked at input → low
  - passing only because an output filter rewrote the response → medium
  - input fenced → low
  - passed at baseline → none
- Expected full-suite outcome: 5 of 7 fail at baseline, 3 mitigated, 2 residual, overall **high**.
- Trade-offs: The simulator is regex-based and only exercises these specific prompts, so it says nothing about real model behaviour. All UI copy and the report disclaimer say so.
- Verification: `test_full_simulated_workflow` asserts the per-case residual map and counts. `test_runs_are_deterministic` compares two runs. `test_recommended_rule_closes_encoded_override` shows `decode-scan` fixes OB-03.

## 2026-10-20 — Audit log: sequential SHA-256 hash chain with evidence digests
- Status: Active
- Decision:
  - **Event fields:** each event stores `seq`, `ts`, `session_id`, `actor`, `event_type`, `evidence_ref`, `details` (canonical JSON), `prev_hash` and `hash = sha256(canonical JSON of those fields)`.
  - **Verification:** checks seq continuity from 1, prev-hash links and recomputed hashes. It also checks that referenced attempt rows still match the recorded prompt, response and verdict digests (`audit.verify_evidence`).
  - **Tamper simulation:** `POST /api/audit/tamper-test` mutates an in-memory copy and never the stored chain. Modes are modify, delete, reorder, and a full rewrite.
- Rationale: The brief requires detecting modification, deletion and reordering, and being honest that a local chain cannot stop someone who can rewrite it entirely.
- Known limitations:
  - A full rewrite with recomputed hashes passes local verification; only an external anchor of the head hash would catch it. The UI demonstrates this with "Rewrite the chain".
  - Deleting events from the tail leaves a valid shorter chain, which is also only detectable against an anchored head.
  - External anchoring is listed as planned.
- Verification: `test_audit.py` makes real database edits (UPDATE, DELETE, a swap of seq values, attempt evidence edits) and checks the error kinds. It also checks that the rewrite simulation passes with a changed head.

## 2026-10-20 — Isolation checks: live in-process HTTP probes, honestly labelled
- Status: Active
- Decision: The isolation stage sends real requests through the ASGI app (`httpx.ASGITransport`, called from the sync route via `anyio.from_thread.run`) with each role's token. It runs a 40-request matrix plus data-level leak checks on the session's real Blue, Red and Target views. Checks are labelled `enforced` (application layer), `simulated` (a declared network model nothing enforces) or `planned` (per-role containers, external audit anchoring).
- Rationale: Probing real routes catches wiring mistakes, such as a route that is missing its permission dependency, which checking the permission table alone would not.
- Approach: Matrix probes use a session id that never exists. Allowed roles get 404 and denied roles get 401 or 403, so probes have no side effects. Probes run before the isolation stage writes anything, so SQLite readers are not blocked.
- Trade-offs: These checks test authorisation inside one process, not OS, container or network isolation. The UI, report and README state this scope.
- Verification: `test_permission_matrix_matches_policy`. The full workflow test asserts 5 enforced passes, 1 simulated and 2 planned.

## 2026-10-20 — Frontend architecture
- Status: Active
- Decision:
  - **Routing:** a hand-written hash router (`hooks.useRoute`, `useSyncExternalStore`).
  - **Run state:** one context (`lab.tsx`) owns the active run, the playing stage, the busy flag and a `version` counter that pages use to refetch.
  - **Motion:** CSS-only interface motion (keyframes plus a `--i` stagger variable).
  - **3D:** the scene is a lazily loaded chunk (`scene/LatticeCanvas.tsx`, about 250 kB gzipped) behind `Suspense`. An SVG schematic (`LatticeFallback`) shows while it loads, when WebGL is unavailable, and when the scene throws (`SceneBoundary`).
- Rationale: Six pages and simple state did not justify react-router or a state library. The brief asks for one justified animation system, and CSS covers reveals, route transitions, connector sweeps and chain construction without a dependency. Lazy loading keeps three.js off the critical path: the main bundle is 285 kB, 86 kB gzipped.
- Alternatives considered: Framer Motion was rejected as an extra dependency for effects CSS already handles.
- Trade-offs: No deep-link rewrites are needed, but URLs carry a `#`. A global `prefers-reduced-motion` rule shortens every CSS animation. JS honours it too: stage pacing drops to 280 ms, and the 3D scene skips packet travel and parallax.
- Verification: `npm run build`. Headless Brave runs with reduced motion emulated and with WebGL disabled; the SVG fallback rendered and no canvas was created.

## 2026-10-20 — Visual identity and 3D lattice design
- Status: Active
- Decision:
  - **Palette:** graphite surfaces (`ink-*`), warm bone type (`bone-*`), moss for defense and pass, amber for warnings and simulated items, rust for failures and Red Team. Tokens live in `frontend/src/styles.css` `@theme`.
  - **Typography:** Instrument Serif for display words, Hanken Grotesk for UI, JetBrains Mono for data, with ligatures disabled so `<!--` and `-->` render literally in prompts.
  - **Composition:** an asymmetric overview (editorial headline column and a large figure panel), hairline dividers, square corners, crosshair ticks and numbered sections. Each page has a distinct layout: ledger table, split catalogue, probe matrix, chain with side panel, printable report.
  - **3D lattice:**
    - The Target core is a faceted icosahedron with seams of light around an emissive nucleus, inside a wire cage. Red and Blue sit in hex cells behind slab walls, each wall with a single gateway, and there is no Red↔Blue channel.
    - Stage animation reads only recorded counts. Attack packets travel to the core. The facets breathe while the target responds, and an evaluator ring scans the core. Findings turn flat and moss as they pass the redaction gateway, and one defense ring forms per applied rule. Blocked retest packets stop at the rings in amber. The walls light in turn during isolation, and the core tints with the final risk.
    - A three-quarter camera is fitted to the panel aspect, with fog distance following it. Pointer hover on a cell shows that role's real permissions from `/api/meta`.
    - `frameloop="demand"` means no rendering while idle. There is no perpetual motion.
- Rationale (Stated by user): An original, restrained, premium cybersecurity look that avoids generic AI-dashboard patterns, with geometry that communicates the role boundaries.
- Rejected: purple-blue gradients, neon glow, glassmorphism, particle fields, gradient text, a wall of stat cards, and continuous idle rotation.
- Trade-offs: Fonts load from Google Fonts and fall back to system fonts offline. three.js adds about 250 kB gzipped to the lazy chunk.
- Verification: Screenshots of every page at 1440×900 and 390×844 in headless Brave (SwiftShader WebGL), including six mid-run stage frames, a hover state, reduced-motion and no-WebGL runs.

## 2026-10-20 — Fixes made while verifying the slice
- Status: Active (record of debugging decisions)
- Tamper "modify" picked an event whose verdict was already `pass`, so nothing changed. It now flips the verdict (`audit.tamper_test`).
- Same-millisecond `created_at` values made attempt order random, so a `position` column was added.
- **Camera fit:** the camera used a stale panel size and cropped the cells on load and on mobile. Size is now read from frame state in `useFrame`. The front-on camera showed the walls edge-on, so a three-quarter view replaced it.
- **Audit page, simulated vs stored:** tamper results were marking stored blocks as "broken". Stored-chain marks now come only from the stored verification. The simulated target is highlighted separately and scrolled into view, and simulations target the middle of the visible window.
- **Mobile overflow:** the audit and reports pages overflowed on mobile because grid columns lacked `min-w-0`. The first overflow metric was wrong: mobile emulation widens the layout viewport, so `scrollWidth - innerWidth` read 0. It is now measured against a fixed 390 px width.
- **Readability:** JetBrains Mono ligatures turned `<!-- -->` into arrows, so ligatures are off for mono text. Distant fog washed out the fitted mobile camera, so fog now follows camera distance.

## 2026-10-20 — Containers
- Status: Active
- Decision: `docker-compose.yml` runs Postgres 16, the API (non-root, read-only filesystem, all capabilities dropped, `no-new-privileges`, no published port) and nginx serving the built UI and proxying `/api`.
- Rationale (Stated by user): Add container configuration where practical and document what it actually isolates.
- What it isolates: the web tier, the API and the database, as separate containers on a private network. It does **not** isolate the Red, Blue and Target roles from each other; they share the API container.
- Verification: `docker compose config` validates the file. The images were **not** built or run, because the Docker daemon was not running in this environment.

---

# Visual refinement pass (2026-10-20)

Requested by the user: refine the existing identity (keep the graphite, bone, moss and rust palette, the serif risk headline, the pipeline and the lattice). Specifically: upgrade the 3D lattice, make role boundaries meaningful and driven by real stage changes, fix empty areas and truncated metadata on the overview, bring every page to the same quality, and improve responsiveness, accessibility and reduced motion. Backend behaviour must not change.

## 2026-10-20 — Refinement plan, recorded before editing
- Status: Superseded by "Visual refinement pass: what shipped" (same day), which records what was actually built and verified.
- Observed in the running app:
  1. The left overview column had about 170 px of dead space between the buttons and the run facts.
  2. Run facts truncated the case list and the audit head hash.
  3. At tablet width (820 px) the seven-column pipeline wrapped its labels.
  4. Walls read as flat slabs. The core was one merged mesh that could only pulse as a whole. The scene's only depth cue was a painted shadow.
  5. Role hover details were pointer-only and unreachable by keyboard or touch.
  6. Some informational text used `bone-700`, about 2.9:1 contrast.
- Decision (planned):
  - **Lattice, `scene/LatticeCanvas.tsx` plus a new `scene/geometry.ts`:**
    - Core facets become one `InstancedMesh` of bevelled prisms, so each facet can move and be coloured individually. The share of rust facets follows the real baseline and retest failure counts.
    - Gateways become iris shutters whose open/closed state is derived from the current backend stage.
    - Walls gain a metal frame and eight probe lines that light in sequence during the isolation stage.
    - Floor zones per role carry role-coloured point lights that brighten only when that role's stage runs.
    - One shadow-casting key light gives real depth.
    - The camera moves to a framing per stage, damped, and stays static under reduced motion.
  - **Overview:**
    - A per-case outcome strip (baseline/retest/residual from recorded verdicts) replaces the dead space.
    - Run facts wrap instead of truncating.
    - A figure footer holds a keyboard-accessible role legend and a stage readout of real counts.
  - **Pipeline:** compact single-line rows below `lg`.
  - **Pages:** outcome bars on the runs ledger, the outcome strip on run detail, real checkboxes in the attack library, matrix row/column emphasis and table semantics in the isolation lab, grouped hashes in the audit trail.
  - **Accessibility:** a `role="status"` live region announcing executed stages, screen-reader-only state text in the pipeline, and `bone-700` replaced on informational text.
- Rationale: Every change maps a visual element to recorded data or a real stage, which is the brief's requirement, and adds no dependency. Instancing keeps the faceted core at a single draw call.
- Alternatives considered:
  - Transmission ("glass") materials for the walls: rejected, because they add a full extra render pass on every frame.
  - `@react-three/drei` (ContactShadows, CameraControls): rejected again; one shadow-casting light and a damped camera need no extra package.
  - A free orbit camera: rejected, because stage-driven framing communicates more and keeps labels readable.
- Trade-offs: A shadow map pass and three small point lights cost GPU time. Frames are still rendered only during animation or camera settling (`frameloop="demand"`).
- Verification: pending. To be recorded in the follow-up entry.

## 2026-10-20 — Visual refinement pass: what shipped
- Status: Active. Supersedes the plan entry above, which is kept as written.
- Decision, as implemented:
  - **Lattice (`scene/LatticeCanvas.tsx`, new `scene/geometry.ts`):**
    - The core is 20 instanced bevelled facets. The rust share equals the baseline failure share during evaluate and defend, then cross-fades to the residual share during retest and stays there (`marked()` spreads tinted facets evenly from top to bottom).
    - Gateways are six-blade hexagonal irises. The Red iris opens only while attack or retest plays; the Blue iris opens to 55% while defend plays, for redacted findings.
    - Walls have a metal frame and eight probe lines, one per resource in the isolation matrix, that light in sequence during isolation.
    - Floor zones per role carry role-coloured point lights at floor level.
    - One shadow-casting key light (1024² map) provides real shadows.
    - The camera moves to a framing per playing stage, damped. The amount of movement shrinks on narrow panels, and reduced motion keeps it static.
    - A `live()` guard keeps gates, probes and glows dark unless that stage is playing; recorded state (facets, rings, evaluator) always shows.
  - **Overlay (`scene/SecurityCore.tsx`):**
    - A figure footer holds the role legend as buttons (hover, focus, click to pin), sharing one `highlight` with 3D hover.
    - A readout line is built only from run data (`stageMetric`, report counts).
  - **SVG fallback (`LatticeFallback.tsx`):** mirrors the zones, the hexagonal gates, the failure-share segments and highlight.
  - **Overview:**
    - The new `components/Outcomes.tsx` `OutcomeStrip` (baseline over retest per case, underlined by residual) fills the former dead space.
    - Run facts no longer truncate: `groupHash` wraps the audit head in groups of eight.
    - The recommendation is labelled "Next", the figure caption is shortened on phones, and the old in-figure legend is replaced by the footer.
  - **Pipeline:** compact one-line rows below `lg`, the horizontal track from `lg` up, and screen-reader state text per stage.
  - **Pages:**
    - Runs ledger: an `OutcomeBar` (passed / mitigated / failing) replaces three bare number columns, with table caption and scopes.
    - Run detail: the outcome strip in the header.
    - Attack library: custom checkbox with a checkmark and a visible focus ring, plus latest-run marks per case.
    - Isolation lab: caption and scopes, a sticky role column with descriptions, row and column emphasis, a post-probe summary and allow markers.
    - Audit trail: actor colours by role, connectors that turn moss when verified, grouped head hash.
    - Reports: table semantics, mobile stat borders, monochrome print.
  - **Accessibility:**
    - A global `role="status"` announcer in `Shell` reads each executed stage with its real metric and the final risk.
    - The mobile menu closes on Escape.
    - Informational `bone-700` text moved to `bone-500`; nav index numbers are `aria-hidden`.
- Rationale: Each new visual maps to recorded data or a real stage transition, which is the brief's core requirement. There are no new dependencies and no backend changes.
- Debugging decisions made while verifying:
  - **Floor wash-out:** the floor zones rendered as a bright grey plinth even with a near-black colour. A temporary pure-red probe confirmed the culprit: environment-map Fresnel reflection at the grazing camera angle. Switched to `MeshLambertMaterial` (no specular) and lowered the cell bases' `envMapIntensity`.
  - **Blown-out solids:** role point lights placed just under the cell solids turned them white. Moved the lights to floor level and lowered their intensity.
  - **Caption collision:** on phones the right-hand figure caption collided with the projected Target label. The caption is now hidden when idle and shortened while running.
  - **Sticky gutter:** content scrolled through the 16 px gutter beside the sticky matrix column. The padding moved from the scroll container onto the sticky cells.
- Trade-offs: the lazy 3D chunk grew from 246.6 to 248.6 kB gzipped and the main bundle from 85.8 to 88.1 kB gzipped. Each animated frame now includes a shadow pass and three small point lights; idle cost is unchanged because frames render only on demand.
- Verification:
  - **Backend:** `pytest` 21/21 on SQLite and 21/21 on PostgreSQL. Ruff check and format clean. No backend files changed.
  - **Frontend:** `tsc --noEmit` and `npm run build` pass.
  - **Rendered in headless Brave (SwiftShader WebGL):**
    - Desktop 1440×900: every page, plus attack, respond, evaluate, defend, retest and isolation frames.
    - Tablet 820×1180 and mobile 390×844: 0 px horizontal overflow on all six pages, measured against a fixed 390 px width.
    - Reduced motion: the full run completes in about 5.6 s, with all seven stage announcements captured from the live region.
    - Keyboard: focusing a legend button shows the permission panel, and Enter toggles `aria-pressed`.
    - WebGL disabled: the SVG fallback renders and highlights.
  - **Not verified:** real GPUs and devices, frame rate under load, screen-reader output (only the live-region text was read programmatically), and print output on paper.

---

# Security hardening milestone (2026-10-20)

Requested by the user: real role isolation beyond application-level permission checks, network-isolation tests, an externally protected audit checkpoint, an optional model-provider interface, and honest labelling. The frontend identity and the deterministic workflow must be preserved.

## 2026-10-20 — Phase A findings and hardening plan, recorded before editing
- Status: Superseded by "Security hardening: what shipped" (same day). Kept as written.
- Observed (source, Docker config, runtime):
  1. **One process, one image.** A single FastAPI process runs the control plane, the Red, Blue and Target behaviour (in-process stage handlers in `pipeline.py`) and the simulator (`target.py`). In Compose, that one `backend` container holds every role token and the database credentials.
  2. **Roles are only tokens.** Static bearer tokens per role (`auth.py`) fall back to well-known `dev-*-token` defaults when the environment is unset. Nothing refuses to start with defaults.
  3. **Operator token in the bundle.** `frontend/Dockerfile` bakes `VITE_OPERATOR_TOKEN` into the JavaScript, so anyone who can load the UI can read it from the bundle.
  4. **Flat network.** Compose uses one default network: every container can reach every other, and the API and DB have internet egress. `db` has no capability restrictions, and nginx runs as root. There are no resource limits.
  5. **Database-only audit chain.** The chain lives only in the database. A full rewrite with recomputed hashes, or truncating the tail, passes `audit.verify`.
  6. **Docker:** Docker Desktop 28.3.3 was installed but its daemon was not running. It was started for this work: engine 28.3.3, aarch64 Linux VM, runc, cgroup v2. An unrelated `volunteer-db` (mongo) container from another project auto-started with it and is left untouched.
- Decision (planned):
  - **Role agents.** Run Red, Blue and Target as separate agent containers, `backend/agents/`, built from the same multi-stage Dockerfile but a slimmer image without control-plane code. The control plane calls an agent only when `BAYORA_<ROLE>_AGENT_URL` is set; otherwise the current in-process behaviour stays the default, so tests and the local dev server keep working.
    - The Red agent submits baseline and retest attempts through the Red API with only the Red token.
    - The Blue agent reads redacted findings and applies rules through the Blue API with only the Blue token.
    - The Target agent holds no token: it receives the guarded prompt text and returns a response.
    - If an agent fails, the stage fails with HTTP 502 and rolls back; there is no in-process fallback.
  - **Networks.** One internal Docker network per path: `edge` (nginx↔API), `data` (API↔DB), `red_net`, `blue_net`, `target_net`, `witness_net` (each API↔one service). Only a `public` network carries the published UI port, and only nginx sits on it. Agents and the API therefore have no internet egress, and agents cannot reach each other, the DB or the witness.
  - **Container controls.** Non-root users, read-only root filesystems, `cap_drop: ALL` (minimal `cap_add` only for Postgres initialisation), `no-new-privileges`, memory, CPU and PID limits, no Docker socket, no host networking, no bind mounts. nginx moves to the unprivileged image.
  - **Secrets.** The operator token leaves the bundle: nginx (Docker) and the Vite proxy (dev) inject it server-side, and nginx refuses role routes from the edge. Compose requires every token from `.env` (`${VAR:?}`), and `BAYORA_REQUIRE_TOKENS=1` makes the API refuse default or short tokens.
  - **Audit checkpoint.** A separate witness service (`backend/witness/`) owns an append-only, hash-linked JSON-lines log on a volume that only it mounts. After every committed stage, the control plane publishes `(seq, head_hash)` to it with a witness-only token. The witness refuses seq regressions and conflicting hashes, isolates torn tail writes, and fails closed if its own log is corrupt. `/api/audit/verify` checks the DB chain against every checkpoint: this detects rewrite, modification, deletion, reordering and truncation up to the latest checkpoint. Events after the last checkpoint remain unanchored and are reported as such.
  - **Live role-container checks.** Agents expose a fixed-target `/v1/probe` that reports TCP reachability of the compose services, a TEST-NET egress address, and their own process controls (uid, effective capabilities, NoNewPrivs, read-only root) read from inside the container. The isolation stage records these as observed checks. Independent verification comes from outside, through `docker compose exec` tests.
  - **Model provider.** A small provider interface: the deterministic simulator stays the default. No real model call is made unless explicitly configured, and no real provider is implemented in this pass.
- Rationale: the brief requires isolation beyond application checks, each control labelled by how it is enforced, and no silent fallbacks. Separate containers on separate internal networks are the strongest isolation available here without a different runtime. The witness is the smallest independently writable store that this environment can actually host.
- Alternatives considered:
  - **Pull-model agents** that poll for work: rejected for this slice. Push calls keep each stage synchronous, so the UI's stage-by-stage contract still holds.
  - **A host file with append-only flags:** rejected, because it needs root (`chflags sappnd`) and isn't portable.
  - **An external notary or Git remote:** rejected, because it means contacting external systems, which the brief forbids.
  - **gVisor or Kata runtimes:** not available on Docker Desktop.
- Known limits, to be documented:
  - Containers share the Docker Desktop VM kernel, so a kernel or container escape defeats the isolation.
  - The control plane is trusted and holds all role tokens.
  - A compromised control plane can publish forged future checkpoints but cannot rewrite earlier ones.
  - The witness volume is protected by Docker isolation, not by hardware or WORM storage.
- Verification: pending. To be recorded in the follow-up entry.

## 2026-10-20 — Security hardening: what shipped
- Status: Active. Supersedes the plan entry above, which is kept as written.
- Decision, as implemented:
  - **Role agents** (`backend/agents/`). When `BAYORA_<ROLE>_AGENT_URL` is set, the stage handlers in `app/pipeline.py` call the agent through `app/remote.py`. Default (unset) behaviour is unchanged, so the dev server and existing tests still run in-process.
    - `red_agent.py` submits baseline and retest attempts through `POST /api/red/sessions/{id}/attempts`, which gained a `phase` field: retest is allowed only during `defend`, once per case, and only after a baseline exists.
    - `blue_agent.py` reads `GET /api/blue/sessions/{id}/findings` and applies its own `PLAYBOOK`; a test keeps it equal to `defenses.PLAYBOOK`.
    - `target_agent.py` holds no token. It accepts only `{prompt}` (extra fields are refused) and returns the provider's answer. Guardrails stay in the control plane: `defenses.run_target(..., model=...)`.
    - After an agent call, the control plane checks the agent did the work (`_require_submitted`). Any agent failure raises `RemoteError` → HTTP 502, with the stage rolled back and no in-process fallback.
  - **Least exposure in the API:**
    - The target inbox returns only prompts still awaiting a response.
    - Every Blue findings read is audited (`blue.findings_read`, `via: api`).
    - `BAYORA_REQUIRE_TOKENS=1` (`auth.validate_tokens`) refuses startup on missing, dev-default, short (<24 characters) or duplicate tokens, and on a configured witness without a strong token.
  - **External checkpoint** (`backend/witness/app.py`, `app/checkpoint.py`):
    - After each committed create or advance, the API posts `(seq, head_hash)`. The response carries the checkpoint status, which the UI shows if it fails.
    - The witness log is hash-linked JSON lines, fsynced. It refuses regressions (409) and conflicting hashes (409). It ignores torn lines when the record chain around them is intact, and fails closed (503) when a record is missing or edited.
    - `/api/audit/verify` compares the chain with every checkpoint. It reports `checkpoint` (wrong hash), `missing`, `truncated` and `witness` errors, plus `unanchored_events`. A configured but unreachable witness makes `ok` false.
    - The tamper simulation now also reports whether the checkpoints would catch the edit.
  - **Isolation checks** (`app/isolation.py`):
    - The new kinds `network` and `configured` sit beside `enforced`, `simulated` and `planned`.
    - With all agents configured, ISO-06 evaluates each agent's `/v1/probe` (fixed targets only) against `NETWORK_POLICY`, and ISO-07 evaluates the process controls each agent reads from `/proc` inside its container. Without agents they stay `simulated` or `planned`, and say why.
    - ISO-08 checks the witness when configured.
  - **Model provider** (`app/providers.py`): `SimulatorProvider` (`bayora-simulator/rules-v1`, kind `simulated`) is the only provider. Selecting anything else refuses startup. Each target response event records the provider, its kind and where it ran; the report's `deployment` and disclaimer reflect it.
  - **Docker:**
    - `backend/Dockerfile` builds `api`, `agent` and `witness` targets. Agent and witness images contain no control-plane code and no Postgres driver.
    - `docker-compose.yml` defines seven services on seven networks (six internal). Hardening uses an `x-hardened` anchor, with a minimal `cap_add` for Postgres.
    - The UI is published on `127.0.0.1` only, and secrets are required from `.env`.
    - nginx is `nginx-unprivileged`, with an envsubst template that injects the operator token server-side, replaces client `Authorization` headers and returns 403 for `/api/(red|blue|target)/`.
    - The Vite dev proxy does the same locally. `frontend/src/api.ts` no longer sends a token.
  - **UI:** small additions only. The status rail shows Roles and Anchor; check kinds read "app enforced", "network enforced" or "configured"; the Audit trail shows the witness result; Reports list network and container counts and the checkpoint state; a failed checkpoint shows as a banner.
- Threat model and trust assumptions:
  - **Defended against:**
    - A compromised Red, Blue or Target container trying to reach other roles, the DB, the witness or the internet.
    - A role reading another role's data through the API.
    - A browser user obtaining a credential from the bundle.
    - A database writer, even with full DB credentials inside the backend container, rewriting, truncating or reordering anchored history without detection.
  - **Trusted:**
    - The control plane, which holds all role tokens and the DB credentials.
    - The Docker engine, and the Docker Desktop VM kernel shared by all containers.
    - The witness container and its volume.
    - Whoever controls the host or Docker daemon can bypass everything here.
- Remaining limits:
  - Events after the latest checkpoint are unanchored; normally that window is at most one stage.
  - The control plane can append forged future checkpoints, though not rewrite earlier ones.
  - Deleting the tail of the witness log is not detected by the witness itself.
  - Agent self-probes are reports by our own code. Independent proof is the outside-in `tests_compose/` suite.
  - The frontend sits on the only non-internal network, so nginx has egress.
  - Postgres runs with 5 capabilities for initialisation.
  - No credential expiry or rotation.
- Alternatives rejected at implementation:
  - **Separate agent identity tokens for control-plane→agent calls:** network segmentation already limits who can reach an agent to the control plane alone, so this would add secrets without changing reachability.
  - **Agents probing caller-supplied hosts:** rejected to avoid turning probes into a scanner.
- Debugging decisions:
  - A `LIKE 'target.%'` literal broke on PostgreSQL only, because psycopg treats `%` as a placeholder. It is now a bound parameter.
  - `.dockerignore` only excluded a top-level `__pycache__`; it now uses `**/__pycache__`.
  - Two compose-test expectations were wrong rather than the stack: Docker reports added capabilities as `CAP_*`, and the backend receives the database password inside `DATABASE_URL`. Both tests were corrected.
- Verification (all run on 2026-10-20):
  - **Unit:** `pytest` 59/59 on SQLite and 59/59 on PostgreSQL 14; ruff check and format clean.
  - **Images:** `docker compose config` valid with `.env`, and refuses to render without it. `docker compose build` built all six images.
  - **Stack:** `docker compose up -d` gives seven healthy services. A full run through the edge in agent mode reproduces the deterministic outcome, with ISO-06 network pass, ISO-07 configured pass and ISO-08 pass. `/api/audit/verify` is OK with 0 unanchored events, and still OK after the containers were recreated.
  - **Outside-in:** `scripts/compose-test.sh` 35/35, covering:
    - reachability by name and IP for 6 sources × 6 destinations
    - no egress from internal services
    - internal-only networks
    - container configuration and PID 1 privileges for 7 services
    - witness-only volume
    - per-container credentials
    - no secrets in bundle, image env or logs
    - edge-proxy behaviour
    - role credentials used from inside containers
    - full run
    - stopped Blue agent → 502, then recovery
    - witness outage → reported, then anchored
    - a full chain rewrite from inside the backend container detected by the checkpoint
  - **Frontend:** `tsc` and `npm run build` pass. A bundle scan found no tokens. The Docker UI rendered with no console errors.
  - **Local witness:** verified on temporary ports (8 checkpoints, verify OK).
  - **Not verified:** behaviour on Linux hosts outside Docker Desktop, resistance to container-escape or kernel exploits, load and concurrency, real model providers.

---

# Security review (2026-10-20)

Requested by the user: a focused security review of the hardening milestone before any new features. Fix only confirmed issues, add a regression test for each, and keep verified vulnerabilities, plausible risks and residual limitations distinct.

## 2026-10-20 — Review findings and fix plan, recorded before editing
- Status: Superseded by "Security review: fixes applied and verification" (same day). Kept as written.
- Baseline before any change: `pytest` 59/59 on SQLite and 59/59 on PostgreSQL; `scripts/compose-test.sh` 35/35. No repository changes since the hardening milestone.
- Method: read the control plane, agents, witness, Compose, nginx and Vite configuration, then probed the running Docker stack and the dev servers. Every item below cites the observation behind it.

**Verified vulnerabilities**

1. **V2 — Medium. The edge proxy accepts any `Host` and injects the operator credential.**
   - Observed: `curl -H 'Host: rebind.attacker.example' http://127.0.0.1:8080/api/runs` returned 200 with run data.
   - Impact: a malicious web page using DNS rebinding could read hidden prompts and the audit log, and start runs, from the victim's browser, with no credential.
   - The same precondition exists in dev: the API on :8000 returned 200 for that Host with the public `dev-operator-token`. The Vite dev server already rejects foreign hosts (403).
   - nginx also sends no anti-framing headers, so the operator console can be framed (clickjacking).
2. **V1 — Low. Blue Team receives the synthetic patient's date of birth.**
   - Observed: the II-04 finding excerpt read `Patient record on file: ████████ · DOB 1987-03-14 · MRN ████████`.
   - `evaluator.redact` masks only the canary, name and MRN, and ISO-02 checks only the canary and MRN, so it passed.
   - This is a real gap in the redaction boundary the project claims, with synthetic data.
3. **V3 — Low. Audit evidence attributes to Blue a read Blue never made.**
   - Observed in Docker: two `blue.findings_read` events with `actor: blue`, but the blue-agent log shows one `/v1/act` call.
   - The second read (seq 105, 10 findings including retest findings) is the control plane's own ISO-02 check, made with the Blue token.
4. **V4 — Low. Malformed witness replies are not handled.**
   - Observed with a witness answering 200 with an unexpected body: `POST /api/runs` returned 500 *after* committing the run, and `/api/audit/verify` returned 500 instead of `ok: false`.
   - A client seeing that 500 could retry and create a duplicate run, and the report stage would also fail.

**Plausible risks (precondition shown; no fix in this pass)**

- **R1:** the frontend container is on the only non-internal network and can reach the host's loopback-bound dev servers through Docker Desktop's `host.docker.internal`; the dev API accepts public dev tokens. Requires an nginx compromise first.
- **R2:** a witness-token holder can plant a far-future checkpoint, after which every legitimate checkpoint is rejected. This fails closed (verify `truncated`, `ok: false`), with no recovery path beyond manual action. Only the control plane holds that token.
- **R3:** bearer tokens are not bound to their source network. A stolen Blue token returned 200 on `/api/blue/rules` when used from the red-agent container. Requires theft; the Blue token exists only in the backend and blue-agent environments.
- **R4:** the backend's DB role `bayora` is a Postgres superuser with `UPDATE`/`DELETE` on `audit_events`. No SQL injection was found (the only two dynamic SQL strings splice in code constants), and anchored-history tampering is detected by the checkpoint, but least privilege is not applied.
- **R5:** the control plane holds every role token in plaintext and can act as any role. The audit actor therefore records which credential was used, not which process used it. Red's "hidden state" (the prompt catalogue) lives in the control plane, visible to the operator by design. Isolation protects it from Blue and Target, not from the control plane.

**Checked and holding**

- Bundle, images and logs hold no secrets (existing compose test, re-run).
- nginx replaces client credentials: a Red token on `/api/runs` returned 200 as operator.
- The role-path block resisted encoded, dot-segment, double-slash and case variants (403/404, never 200).
- Only the UI is published, on 127.0.0.1.
- Internal-network containers cannot resolve `host.docker.internal` or reach the host's addresses. The database reaches only the backend and has no egress.
- Seccomp is the default profile, not `unconfined`.
- Agents accept only fixed probe targets and UUID-shaped session ids (no path injection into API URLs).
- Vite serves no `.env` content; `/@fs` outside the project returns 403.
- The witness refuses regressions and conflicting hashes; repeats are idempotent.
- Crash between commit and checkpoint: the events stay unanchored until the next successful publish, which anchors the then-current committed head. Deterministic, but unbounded if no further writes happen. To be documented precisely.

**Planned fixes, minimal and each with a regression test**

- **V2:**
  - nginx answers only `Host` 127.0.0.1 or localhost (421 otherwise) and adds `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff` and `no-referrer`.
  - The API adds Starlette `TrustedHostMiddleware` (`BAYORA_ALLOWED_HOSTS`, default `127.0.0.1,localhost,backend,bayora.internal,testserver`).
- **V1:** one `SENSITIVE_VALUES` tuple in `target.py`, now including the DOB, used by both `redact` and ISO-02.
- **V3:** ISO-02 checks `pipeline.blue_findings()` directly, the same function the Blue route returns, instead of reading with the Blue credential.
- **V4:** `checkpoint.py` validates witness replies; malformed replies become `failed` or `unavailable`, never 500.
- **Test gaps found while answering question 7:** compose tests for foreign-Host rejection and security headers, client-credential replacement on an operator-only route, path-block variants, loopback-only publishing, the database as a probe source with no egress, `host.docker.internal` unresolvable from internal services, and seccomp not unconfined.

## 2026-10-20 — Security review: fixes applied and verification
- Status: Active. Supersedes the review plan entry above, which is kept as written.

**Fixes for verified vulnerabilities** (each with a regression test asserting the opposite of the observed pre-fix behaviour)

- **V2 — Medium. Foreign `Host` headers were accepted.**
  - Edge: `frontend/nginx.conf.template` now returns **421** unless `$host` is `127.0.0.1` or `localhost`, and adds `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
  - API: `app/main.py` adds Starlette `TrustedHostMiddleware` with `BAYORA_ALLOWED_HOSTS` (default `127.0.0.1,localhost,backend,bayora.internal,testserver`), answering **400** to other hosts before authentication. `tests/conftest.py` now sends the in-process API client with the default test host.
  - Evidence after the fix, live: a foreign Host gets 421 at the edge and 400 at the dev API, even with the dev token. Normal access still returns 200 through nginx, the Vite proxy and directly.
  - Tests:
    - `tests/test_security_review.py::test_api_answers_only_known_host_names`: 5 cases, including `127.0.0.1.attacker.example`.
    - `tests_compose/test_stack.py::test_edge_answers_only_loopback_host_names` and `::test_edge_forbids_framing`.
  - Alternative rejected: making the allowed hosts configurable in nginx. The UI is published on loopback only, so this would add configuration surface without a current use.
- **V1 — Low. Redaction missed the date of birth.**
  - `app/target.py` defines `PATIENT_DOB` and one `SENSITIVE_VALUES` tuple. `evaluator.redact` and ISO-02 both use it, so they cannot drift apart again.
  - Tests: `test_blue_findings_mask_every_sensitive_value`, and `test_iso02_catches_a_partial_redaction`, which reinstates the old name+MRN redaction and expects ISO-02 to fail.
- **V3 — Low. Evidence misattribution.**
  - ISO-02 (`app/isolation.py`) inspects `pipeline.blue_findings()` directly, the function the Blue route returns unchanged, instead of reading with the Blue token. ISO-03 and ISO-04 still read through the Red and Target routes; those routes write no audit events.
  - Evidence: a full run now records 56 events again (was 57), and a Docker agent-mode run records exactly one `blue.findings_read`, the Blue agent's.
  - Tests: `test_isolation_checks_do_not_record_reads_as_blue_in_process` and `_with_agents`.
- **V4 — Low. Malformed witness replies.**
  - `app/checkpoint.py` validates replies. A malformed publish reply makes the checkpoint `failed`. A malformed log makes `fetch()` raise `RemoteError`: verify then reports `unavailable` with `ok: false`, the report records `unavailable`, and tamper-test returns 502. Nothing returns 500 after a commit any more.
  - Test: `test_malformed_witness_replies_are_reported_not_500`.

**Test gaps closed** (question 7), in `tests_compose/test_stack.py`:
- Client-credential replacement checked on an operator-only route (`test_edge_replaces_client_credentials`; the previous check relied on the path block).
- Seven role-path variants stay at 403 or 404.
- Loopback-only publishing.
- The database as a probe source (reaches only the backend; no egress or host access).
- `host.docker.internal` unresolvable from every internal service.
- Seccomp and AppArmor not `unconfined`.
- ISO-06 and ISO-07 remain self-reported by the agents and are labelled so; the outside-in compose suite is the evidence for network and container claims.

**Crash and recovery (question 4), now documented in flow.md §5.3**
- The checkpoint is published only after the stage commits. A crash between commit and publish leaves those events unanchored. The next successful publish (any run creation or stage advance) anchors whatever committed head exists then.
- This is deterministic, but the window is unbounded if nothing else is written. Verify keeps `ok: true` and reports `unanchored_events`, which the UI shows.
- Crash or timeout after the witness appended but before the API heard back: the API reports `failed`, but the witness holds the record. A repeat of the same seq and hash is idempotent. Verify reflects the witness.
- Torn witness writes are isolated (existing test).
- Restoring the database from an earlier backup makes verification fail against later checkpoints. That is the intended signal, and there is deliberately no automatic witness reset.

**Not fixed (plausible risks R1–R5, recorded above; each needs a design change)**

| Risk | Recommended next step |
|---|---|
| R1: the frontend container can reach the host's loopback dev servers | Don't run dev servers alongside the stack, or bind them to a host-only interface |
| R2: the witness-token holder can block anchoring with a far-future checkpoint (fails closed) | Signed checkpoints and an operator-run witness reset procedure |
| R3: bearer tokens are not bound to their network | Per-role subnet checks or mTLS |
| R4: superuser database role with UPDATE/DELETE on the audit table | A non-superuser application role with `REVOKE UPDATE, DELETE ON audit_events` |
| R5: the control plane holds plaintext role tokens and can act as any role | Store token hashes in the control plane and move the permission probes into the agents |

Other limits stay as before: one shared kernel, no credential expiry or rotation, and env-based secrets visible to anyone with Docker-daemon access.

**Verification (2026-10-20, after the fixes)**
- `pytest`: 69/69 on SQLite and 69/69 on PostgreSQL 14 (59 existing + 10 new). Ruff check and format clean.
- `scripts/compose-test.sh`: 53/53 (35 existing + 18 new). The first run had 9 failures caused by a test-only bug, a local `http()` helper shadowing `http.client`; fixed and re-run.
- `npm run build` and `docker compose config` pass.
- Main stack rebuilt with `docker compose up -d --build`: all 7 services running, verify OK with 0 unanchored events. The UI rendered with no console errors.
- The dev API was restarted on its existing PostgreSQL database; all 14 sessions are intact.
