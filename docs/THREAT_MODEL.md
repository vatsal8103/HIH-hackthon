# Bayora Architecture Threat Model & Residual Risk Matrix

**Track 4: Securing Adversarial AI Safety Testing Infrastructure**  
**Hack in Hills '26**

---

## 1. System Overview & Security Boundaries

Bayora isolates adversarial red-teaming workflows where untrusted attack prompts, defensive rules, and target model outputs interact. The architecture establishes strict zero-knowledge boundaries between competing roles (Red, Blue, Target, Operator) and anchors all evaluation evidence into an immutable, witness-verified audit trail.

Bayora supports two deployment architectures:
1. **Docker Container Stack**: Multi-bridge networks (`red-net`, `blue-net`, `target-net`, `witness-net`), `cap_drop: ALL`, non-root users (`nobody`), read-only root filesystems, and container cgroups limits.
2. **Non-Container / Local Process Architecture**: Independent OS child processes strictly bound to `127.0.0.1` (ports 8000–8004), isolated directories (`.run/<role>`) with 0700/0600 DACLs, scrubbed per-role process environments, OS sandboxing primitives (Linux bubblewrap namespaces, firejail, dedicated `bayora-*` service accounts, and Windows Job Objects), loopback host firewall barriers, and zero-credential target processes.

```
+-----------------------------------------------------------------------------------------+
|                                    Host Boundary                                        |
|                                                                                         |
|  +----------------+        HTTPS / TLS         +-------------------------------------+  |
|  | Operator / Web | -------------------------> |   Control Plane (Port 8000)         |  |
|  | Client Browser |                            |   - Ed25519 Grant Issuance & RBAC   |  |
|  +----------------+                            |   - Redacted Audit Alert Monitor    |  |
|                                                |   - Response Quantization (10ms)    |  |
|                                                |   - Canary & Context Leak Guards    |  |
|                                                +--+----------------+---------------+--+  |
|                                                   |                |               |    |
|                          Loopback + Firewall (8002)   Loopback (8003)    Loopback (8004)|
|                                                   v                v               v    |
|                                            +------------+   +------------+   +--------+ |
|                                            | Red Agent  |   | Blue Agent |   | Target | |
|                                            | (bwrap/Job)|   | (bwrap/Job)|   | Model  | |
|                                            +------------+   +------------+   +----+---+ |
|                                                                                   |     |
|  +--------------------------------+                             +-----------------v--+  |
|  | Witness Log & Recovery Daemon  | <--- Checkpoints (8001) --- | Local Simulator /  |  |
|  | (Independent Volume & Process) |                             | Ollama (keep_alive |  |
|  +--------------------------------+                             | =0) / Cloud Model  |  |
|                                                                 +--------------------+  |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Threat Matrix

Each row documents a specific adversarial or infrastructure threat, its protection mechanism, failure boundary, verified automated test, and honest implementation status (`Implemented`, `Partial`, `Simulated`, or `Planned`).

| Threat | Protected? | Status | How it is Protected | When it Breaks (Failure Mode) | Verified Test | Future Improvement |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **Red reads Blue defenses / Blue reads Red attacks** | **Yes** | **Implemented** | Strict RBAC permissions (`app/auth.py`), signed Ed25519 role tokens, isolated Docker bridge networks or loopback port segregation (8002 vs 8003), control plane zero-knowledge redaction. | Control plane kernel compromise or operator manually leaking logs. | `backend/tests/test_permissions.py::test_role_permissions`, `backend/tests/test_monitor.py::test_alert_created_on_forbidden_role_call` | Asymmetric envelope encryption of attack payloads and defense rules. |
| **Target contamination across sessions** | **Yes** | **Implemented** | Per-request stateless context construction (`app/llm_isolation.py`), strict session isolation guard (`ISO-09`), automated session canary probe (`ISO-10`). | Underlying inference daemon retaining multi-turn memory or global conversation cache. | `backend/tests/test_llm_isolation.py::test_cross_session_context_guard_pass`, `backend/tests/test_llm_isolation.py::test_deliberate_leak_detected` | Per-session ephemeral container destruction and rebuild. |
| **Audit log tampering (including DB owner rewrite)** | **Yes** | **Implemented** | Cryptographic SHA-256 hash chaining of all events; independent witness checkpoint service on dedicated port/network (`ISO-08`); DB role `bayora_app` denied UPDATE/DELETE; standalone offline verifier (`scripts/verify_audit.py`). | Simultaneous compromise of both SQLite/PostgreSQL database and witness log file/volume. | `backend/tests/test_checkpoint.py`, `backend/tests/test_witness_recovery.py`, `backend/tests/test_verify_audit.py` | Multi-witness Byzantine threshold consensus; public ledger transparency anchoring. |
| **Container escape via shared kernel** | **Partial** | **Partial** | Hardened container profiles: `cap_drop: ALL`, `no-new-privileges: true`, non-root user (`nobody`), custom seccomp profile, read-only root filesystems (`ISO-07`). In non-container mode: Linux bubblewrap namespaces or Windows Job Objects. | 0-day host Linux kernel privilege escalation exploit (e.g. dirty COW, eBPF bug). | `backend/tests_compose/test_stack.py::test_container_capabilities_and_security_options`, `backend/tests/test_os_sandboxing.py` | Hardware virtualization microVM isolation (AWS Firecracker, gVisor `runsc`, Kata). |
| **Host filesystem cross-contamination in non-container mode** | **Yes** | **Implemented** | Local setup generates separate `.run/<role>` runtime directories with 0700 directory permissions and 0600 file DACLs (`local_setup.py`); child agent runners scrub foreign role environment variables; Linux bubblewrap mounts only own role directory. | Malicious agent process executing with root/superuser privileges overriding local filesystem permissions. | `backend/tests/test_local_process_isolation.py`, `backend/tests/test_os_sandboxing.py::test_file_isolation_verification` | Mandatory Access Control policies (SELinux / AppArmor profiles). |
| **Unauthenticated cross-role loopback reach** | **Yes** | **Implemented** | Local agents bind strictly to loopback (`127.0.0.1`); peer dispatches (`/v1/act`, `/v1/respond`) strictly require CP-issued signed session grants; empirical barrier probes classify network boundaries ("blocked by OS" vs "blocked by authentication only", `ISO-06`); host firewall scripts (iptables / NetFirewallRule). | Misconfigured firewall allowing direct loopback socket connections with compromised private key. | `backend/tests/test_local_network_control.py`, `backend/tests/test_local_process_isolation.py::test_cross_role_direct_request_rejected` | Kernel-level network namespaces (`ip netns`) for unprivileged processes. |
| **Target model outbound exfiltration** | **Yes** | **Implemented** | Target agent holds ZERO private signing keys; excluded from `credentials.signed_roles()`; target only answers inbound requests carrying valid CP grants; non-loopback egress dropped. | Target model code modified to inject outbound socket calls before grant verification. | `backend/tests/test_llm_isolation.py::test_target_holds_no_outbound_signing_credentials`, `backend/tests/test_local_process_isolation.py::test_target_cannot_forge_signed_requests` | Outbound socket syscall restriction via seccomp filter. |
| **Timing & resource side channels** | **Partial** | **Partial** | Discrete response-time padding middleware (`timing_mitigation_middleware`, 10ms quantum, `X-Timing-Protection: quantized`); container CPU/memory bounds or Windows Job Objects quota (`ISO-12`); honest reporting when limits are unconstrained. | Sub-millisecond CPU microarchitectural cache attacks (Flush+Reload, Prime+Probe), memory bus contention. | `backend/tests/test_fairness.py::test_timing_mitigation_middleware`, `backend/tests/test_fairness.py::test_evaluate_target_fairness_default` | Physical CPU core pinning (`cpuset`) and constant-time queue processing. |
| **Shared KV-cache leakage in model provider** | **Partial** | **Simulated** | Control plane enforces stateless single-turn calls with `keep_alive: 0` for immediate model eviction; output isolation scanner (`ISO-11`) flags prompt/defense residues; explicit UI report disclaimer. | Multi-tenant inference server (vLLM, Ollama) sharing GPU prefix cache blocks across tenants. | `backend/tests/test_llm_isolation.py::test_output_isolation_scanner_clean`, `backend/tests/test_llm_isolation.py::test_deliberate_leak_detected` | Per-tenant GPU memory partitioning or confidential computing hardware enclaves. |
| **Compromised signing key** | **Yes** | **Implemented** | Asymmetric Ed25519 verification with Key IDs (`kid`); real-time key revocation endpoint (`POST /api/credentials/revocations`) rejects revoked credentials immediately. | Stolen private key used prior to revocation notice being published to audit chain. | `backend/tests/test_credentials.py::test_revocation_lifecycle`, `backend/tests/test_permissions.py::test_revoked_key_rejected` | Ephemeral short-lived credentials (5-minute TTL) with hardware HSM storage. |
| **Data leakage to third-party provider (Groq)** | **Partial** | **Partial** | Default mode uses 100% offline local simulator; live cloud models require opt-in and display explicit warnings; TLS 1.3 transit encryption. | Third-party provider compromises, internal logging, or server-side model retention. | `backend/tests/test_providers.py`, `frontend/src/pages/HowItWorks.tsx` | Local-only offline weights (Llama 3 / Qwen) or differential privacy proxy. |
| **Operator credential sharing** | **Yes** | **Implemented** | Fine-grained RBAC permissions (`PERMISSIONS`); immutable audit log of operator commands; sliding-window rate limiting on alert queries (60 req/min). | Multiple human operators sharing identical credentials prevents individual attribution. | `backend/tests/test_monitor.py::test_alerts_endpoint_rate_limiting`, `backend/tests/test_permissions.py::test_operator_permissions` | OIDC / SAML SSO with mandatory Multi-Factor Authentication (MFA) per operator. |
| **Direct Prompt Injection bypass** | **Partial** | **Implemented / Heuristic** | Multi-layer input defenses (`instruction-guard`, `persona-lock`, `decode-scan`) + output canary redaction (`secret-egress-filter`). | Novel token encoding, unicode homoglyphs, or semantic payload splitting (`PS-05`). | `backend/tests/test_workflow.py`, `backend/tests/test_evaluator.py` | Fine-tuned classifier guard models (Llama Guard / NeMo Guardrails). |
| **Indirect Prompt Injection via data files** | **Partial** | **Implemented / Heuristic** | Content fence stripping hidden markup (`<!-- ... -->`) before document content reaches target model. | Multi-language hidden formatting, zero-width spaces, or Markdown image exfiltration. | `backend/tests/test_ii04_design.py`, `backend/tests/test_workflow.py` | Structural document parser with strict schema sanitization. |

---

## 3. Residual Risk Assessment

### 3.1 What is Guaranteed
1. **Cryptographic Proof of Execution**: Every attack prompt, target response, evaluation metric, and isolation check is SHA-256 hashed and verifiable against the separate witness log. Any retro-active tampering is mathematically detectable offline via `scripts/verify_audit.py`.
2. **Role Non-Interference**: Red agents cannot read active defense rules; Blue agents cannot read unredacted attack payloads.
3. **Audit Immutability against Database Owners**: Even a database superuser altering SQLite/PostgreSQL rows will fail hash-chain verification and witness consistency proofs.
4. **Target Model Zero-Credential Egress**: Target inference engines are prevented from signing messages or dispatching unauthorized requests to peer roles.

### 3.2 What is NOT Guaranteed
1. **Zero-Day Kernel Isolation**: Host processes and containers share the underlying operating system kernel. While namespace isolation (bubblewrap) and Windows Job Objects restrict interaction, complete hostile binary containment requires hardware-virtualized microVMs.
2. **Elimination of Host Microarchitectural Timing**: Quantizing response times to 10ms buckets masks network-observable token generation latency, but does not prevent hyperthread cache contention or memory bus timing on bare-metal hosts.
3. **Third-Party Model Privacy**: When using external providers (Groq API), prompt data exits the local security perimeter subject to external API privacy policies.

