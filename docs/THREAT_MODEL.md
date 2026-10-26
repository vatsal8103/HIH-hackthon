# Bayora Architecture Threat Model & Residual Risk Matrix

**Track 4: Securing Adversarial AI Safety Testing Infrastructure**  
**Hack in Hills '26**

---

## 1. System Overview & Security Boundaries

Bayora isolates adversarial red-teaming workflows where untrusted attack prompts, defensive rules, and target model outputs interact. The architecture establishes strict zero-knowledge boundaries between competing roles (Red, Blue, Target, Operator) and anchors all evaluation evidence into an immutable, witness-verified audit trail.

```
+-------------------------------------------------------------------------+
|                              Host Boundary                              |
|                                                                         |
|  +----------------+     HTTPS (TLS)     +----------------------------+  |
|  | Operator / Web | ------------------> |   Edge Relay / Nginx Proxy |  |
|  | Client Browser |                     |   Host-header validation   |  |
|  +----------------+                     +--------------+-------------+  |
|                                                        |                |
|                                          Internal Unix | or Loopback    |
|                                                        v                |
|  +-------------------------------------------------------------------+  |
|  |                     FastAPI Control Plane                         |  |
|  |   - Ed25519 Signature Verification & Token Expiry / Replay Guard  |  |
|  |   - Zero-Knowledge Role RBAC (Red != Blue != Operator)           |  |
|  |   - Real-Time Monitor & Redacted Alert Engine                     |  |
|  |   - Response Quantization Padding Middleware (10ms Quantum)       |  |
|  |   - Cross-Session Context & Canary Isolation Engine               |  |
|  +-------+--------------------+--------------------+-----------------+  |
|          | (red-net)          | (blue-net)         | (target-net)       |
|          v                    v                    v                    |
|  +---------------+    +---------------+    +------------------------+   |
|  |   Red Agent   |    |   Blue Agent  |    |   Target Agent / LLM   |   |
|  | (Seccomp/Cap) |    | (Seccomp/Cap) |    | (Stateless per request)|   |
|  +---------------+    +---------------+    +-----------+------------+   |
|                                                        |                |
|  +---------------------------+        +----------------v-------------+  |
|  | Witness Checkpoint Daemon |        | Local Simulator / Ollama /  |  |
|  | (Isolated Storage Volume) |        | Hosted Provider (Groq API)   |  |
|  +---------------------------+        +------------------------------+  |
|                                                                         |
+-------------------------------------------------------------------------+
```

---

## 2. Threat Matrix

Each row documents a specific adversarial or infrastructure threat, its protection mechanism, failure boundary, verified automated test, and honest implementation status (`Implemented`, `Partial`, `Simulated`, or `Planned`).

| Threat | Protected? | Status | How it is Protected | When it Breaks (Failure Mode) | Verified Test | Future Improvement |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **Red reads Blue defenses / Blue reads Red attacks** | **Yes** | **Implemented** | Strict RBAC permissions (`app/auth.py`), signed Ed25519 role tokens, isolated Docker bridge networks (`red-net`, `blue-net`), control plane zero-knowledge redaction. | Control plane kernel compromise or operator manually leaking logs. | `backend/tests/test_permissions.py::test_role_permissions`, `backend/tests/test_monitor.py::test_alert_created_on_forbidden_role_call` | Asymmetric envelope encryption of attack payloads and defense rules. |
| **Target contamination across sessions** | **Yes** | **Implemented** | Per-request stateless context construction (`app/llm_isolation.py`), strict session isolation guard (`ISO-09`), automated session canary probe (`ISO-10`). | Underlying inference daemon retaining multi-turn memory or global conversation cache. | `backend/tests/test_llm_isolation.py::test_cross_session_context_guard_pass`, `backend/tests/test_llm_isolation.py::test_deliberate_leak_detected` | Per-session ephemeral container destruction and rebuild. |
| **Audit log tampering (including DB owner rewrite)** | **Yes** | **Implemented** | Cryptographic SHA-256 hash chaining of all events; independent witness checkpoint service on dedicated network (`ISO-08`); DB role `bayora_app` denied UPDATE/DELETE. | Simultaneous compromise of both PostgreSQL database and witness log volume. | `backend/tests/test_checkpoint.py`, `backend/tests/test_witness_recovery.py`, `backend/tests_compose/test_stack.py::test_full_chain_rewrite_detected` | Multi-witness Byzantine threshold consensus; public ledger transparency anchoring. |
| **Container escape via shared kernel** | **Partial** | **Partial** | Hardened container profiles: `cap_drop: ALL`, `no-new-privileges: true`, non-root user (`nobody`), custom seccomp profile, read-only root filesystems (`ISO-07`). | 0-day host Linux kernel privilege escalation exploit (e.g. dirty COW, eBPF bug). | `backend/tests_compose/test_stack.py::test_container_capabilities_and_security_options` | Hardware virtualization microVM isolation (AWS Firecracker, gVisor `runsc`, Kata). |
| **Timing & resource side channels** | **Partial** | **Partial** | Discrete response-time padding middleware (`timing_mitigation_middleware`, 10ms quantum, `X-Timing-Protection: quantized`); container CPU/memory bounds (`ISO-12`). | Sub-millisecond CPU microarchitectural cache attacks (Flush+Reload, Prime+Probe), memory bus contention. | `backend/tests/test_fairness.py::test_timing_mitigation_middleware`, `backend/tests/test_fairness.py::test_evaluate_target_fairness_pass` | Physical CPU core pinning (`cpuset`) and constant-time queue processing. |
| **Shared KV-cache leakage in model provider** | **Partial** | **Simulated** | Control plane enforces stateless single-turn calls with `keep_alive: 0`; output isolation scanner (`ISO-11`) flags prompt/defense residues; explicit UI report disclaimer. | Multi-tenant inference server (vLLM, Ollama) sharing GPU prefix cache blocks across tenants. | `backend/tests/test_llm_isolation.py::test_output_isolation_scanner_clean` | Per-tenant GPU memory partitioning or confidential computing hardware enclaves. |
| **Compromised signing key** | **Yes** | **Implemented** | Asymmetric Ed25519 verification with Key IDs (`kid`); real-time key revocation endpoint (`POST /api/credentials/revocations`) rejects revoked credentials immediately. | Stolen private key used prior to revocation notice being published to audit chain. | `backend/tests/test_credentials.py::test_revocation_lifecycle`, `backend/tests/test_permissions.py::test_revoked_key_rejected` | Ephemeral short-lived credentials (5-minute TTL) with hardware HSM storage. |
| **Data leakage to third-party provider (Groq)** | **Partial** | **Partial** | Default mode uses 100% offline local simulator; live cloud models require opt-in and display explicit warnings; TLS 1.3 transit encryption. | Third-party provider compromises, internal logging, or server-side model retention. | `backend/tests/test_providers.py`, `frontend/src/pages/HowItWorks.tsx` | Local-only offline weights (Llama 3 / Qwen) or differential privacy proxy. |
| **Operator credential sharing** | **Yes** | **Implemented** | Fine-grained RBAC permissions (`PERMISSIONS`); immutable audit log of operator commands; sliding-window rate limiting on alert queries (60 req/min). | Multiple human operators sharing identical credentials prevents individual attribution. | `backend/tests/test_monitor.py::test_alerts_endpoint_rate_limited`, `backend/tests/test_permissions.py::test_operator_permissions` | OIDC / SAML SSO with mandatory Multi-Factor Authentication (MFA) per operator. |
| **Direct Prompt Injection bypass** | **Partial** | **Implemented / Heuristic** | Multi-layer input defenses (`instruction-guard`, `persona-lock`, `decode-scan`) + output canary redaction (`secret-egress-filter`). | Novel token encoding, unicode homoglyphs, or semantic payload splitting (`PS-05`). | `backend/tests/test_workflow.py`, `backend/tests/test_evaluator.py` | Fine-tuned classifier guard models (Llama Guard / NeMo Guardrails). |
| **Indirect Prompt Injection via data files** | **Partial** | **Implemented / Heuristic** | Content fence stripping hidden markup (`<!-- ... -->`) before document content reaches target model. | Multi-language hidden formatting, zero-width spaces, or Markdown image exfiltration. | `backend/tests/test_ii04_design.py`, `backend/tests/test_workflow.py` | Structural document parser with strict schema sanitization. |

---

## 3. Residual Risk Assessment

### 3.1 What is Guaranteed
1. **Cryptographic Proof of Execution**: Every attack prompt, target response, evaluation metric, and isolation check is SHA-256 hashed and verifiable against the separate witness log. Any retro-active tampering is mathematically detectable.
2. **Role Non-Interference**: Red agents cannot read active defense rules; Blue agents cannot read unredacted attack payloads.
3. **Audit Immutability against Database Owners**: Even a database superuser altering SQLite/PostgreSQL rows will fail hash-chain verification and witness consistency proofs.

### 3.2 What is NOT Guaranteed
1. **Zero-Day Kernel Isolation**: Docker containers share the host Linux kernel. Hardened seccomp profiles reduce syscall exposure, but true adversarial isolation against hostile native binary payloads requires microVMs.
2. **Elimination of Host Microarchitectural Timing**: Quantizing response times to 10ms buckets masks network-observable token generation latency, but does not prevent hyperthread cache contention on bare-metal hosts.
3. **Third-Party Model Privacy**: When using external providers (Groq API), prompt data exits the local security perimeter subject to external API privacy policies.
