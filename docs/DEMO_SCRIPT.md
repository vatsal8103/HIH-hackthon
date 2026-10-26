# Bayora: 3-Minute Judge Presentation Script & Top 5 Q&A

**Hack in Hills '26 · Track 4: Securing Adversarial AI Safety Testing Infrastructure**

---

## 1. 3-Minute Demo Script

### [0:00 – 0:45] The Problem & The Architecture
- **Navigate to:** `http://127.0.0.1:8080/#/` (Overview)
- **Presenter:**
  > "Welcome to Bayora. When enterprises deploy LLMs — like this clinic assistant — they face a severe dilemma: adversarial AI red-teaming is essential to find prompt injection and data leaks, but the safety testing infrastructure itself is highly vulnerable. Red teams shouldn't see Blue defenses; Blue teams shouldn't see unredacted attack payloads; and test sessions cannot contaminate one another.
  >
  > Bayora is a zero-knowledge adversarial AI safety testing lab. Notice our 3D Security Core: each facet represents an evaluated security boundary. The pipeline on screen shows our seven strictly segmented stages: Attack, Respond, Evaluate, Defend, Retest, Isolate, and Report."

### [0:45 – 1:30] Execution, Evaluation & Zero-Knowledge Defense
- **Navigate to:** `http://127.0.0.1:8080/#/demo` (Guided Demo)
- **Presenter:**
  > "Let's walk through our guided test case with attack `PI-01: Direct instruction override`.
  >
  > On step 2, the Red team attempts to force the assistant to dump its internal configuration and secret canary token.
  >
  > On step 3, our Evaluator analyzes the output: the baseline model failed and leaked confidential data.
  >
  > On step 4, the Blue team responds. Notice the strict boundary: Blue receives only a redacted failure code, never the attack prompt. From this, Blue activates the `instruction-guard` filter. On the retest, the injection is blocked at the perimeter."

### [1:30 – 2:15] Continuous Monitoring & Cryptographic Witness Verification
- **Presenter (Still on Step 4 & 5 of `#demo`):**
  > "While tests run, our continuous monitor watches for unauthorized access. Right here on Step 4, let's trigger a live boundary violation alert. Notice that the alert logs only the role, timestamp, and coarse reason code `DEMO_VIOLATION` — zero attack or defense text is leaked.
  >
  > Now look at Step 5: Evidence. Every single prompt, response, metric, and alert is hashed into a SHA-256 chain and anchored to an independent witness container.
  >
  > Judges often ask: what if an attacker with database root access modifies or deletes a finding? Let's click **'Simulate record modification'**. Immediately, verification fails: the hash link breaks and mismatches the witness. Tampering is mathematically impossible to conceal."

### [2:15 – 3:00] Cross-Session Isolation & Honest Threat Model
- **Navigate to:** Step 6 of `#demo` and `http://127.0.0.1:8080/#/reports`
- **Presenter:**
  > "On Step 6, we verify LLM cross-session isolation: our `ISO-09` context guard and `ISO-10` canary tests prove that Session A cannot contaminate Session B through conversational residue.
  >
  > Finally, let's open our **Architecture Threat Model** under Risk Reports. We don't claim magical security. We provide an honest matrix of 11 threats: from cryptographic witness proof (Implemented and tested) to container kernel sharing (Partial, requiring microVMs in future work).
  >
  > Bayora provides the verifiable, zero-knowledge foundation needed to red-team AI models safely."

---

## 2. Top 5 Judge Questions & Honest Engineering Answers

### Q1: "Why use a simulated target and a fixed Blue playbook instead of live LLMs for everything?"
**Honest Answer:**
> "Reproducibility and regression testing. In security testing infrastructure, tests must be 100% deterministic so you know that an isolation failure or canary leak is caused by an architectural regression, not LLM stochastic noise. 
> 
> However, Bayora fully supports live LLMs: we include providers for local Ollama and hosted Groq API models. When live mode is enabled, the UI clearly displays transparency warnings that prompts leave the container."

### Q2: "Does Docker container isolation guarantee protection against hostile executable code?"
**Honest Answer:**
> "No, and we are completely transparent about this in our Threat Model (`docs/THREAT_MODEL.md`). Docker containers share the host Linux kernel. 
> 
> We implement defense-in-depth: non-root execution (`nobody`), dropping all Linux capabilities (`cap_drop: ALL`), read-only root filesystems, `no-new-privileges: true`, custom seccomp profiles, and PID/memory quotas. However, protection against 0-day kernel exploits requires hardware-level microVMs (such as AWS Firecracker, gVisor `runsc`, or Kata Containers), which we document as our planned next step."

### Q3: "How does the witness service prevent audit tampering if the database is compromised?"
**Honest Answer:**
> "Through architectural segmentation and independent cryptographic checkpoints. The audit log is an append-only SHA-256 hash chain where every event commits to the hash of the preceding event. 
> 
> Crucially, the witness runs in a separate Docker container on an isolated internal network (`witness_net`) with its own independent volume. After each stage, the control plane sends a cryptographic checkpoint to the witness. Even if an attacker gains database superuser access and rewrites the database rows, the recomputed root hash will conflict with the witness log's immutable checkpoint, immediately failing verification."

### Q4: "Can timing side channels or burst traffic from Red leak information about Blue defenses or model state?"
**Honest Answer:**
> "We addressed this in Part 3 with discrete response-time quantization. Our control plane middleware quantizes Red and Blue endpoint elapsed durations into 10ms quantum buckets (`X-Timing-Protection: quantized`). Furthermore, container CPU (0.5 cores) and memory (256MB) limits prevent denial-of-service or resource starvation. 
> 
> In our report disclaimer, we honestly note that microarchitectural CPU cache contention (Flush+Reload) on shared physical cores cannot be eliminated without dedicated hardware core pinning (`cpuset`)."

### Q5: "How do you ensure prompts and secrets from one test session do not leak into another?"
**Honest Answer:**
> "In Part 1, we implemented `backend/app/llm_isolation.py` with three automated checks:
> 1. `ISO-09` (Session Context Guard): Verifies that each test session constructs a fresh, stateless message history with zero prompt residue from prior sessions.
> 2. `ISO-10` (Session Canary Probe): Injects an ephemeral random token into Session A's context and asserts 0% presence in Session B's inputs and outputs.
> 3. `ISO-11` (Output Isolation Scanner): Scans generated outputs to confirm no Blue defense rules or cross-attack strings leak.
> 
> We explicitly disclaim in our report that shared multi-tenant GPU KV caches (e.g., in hosted providers) are outside container boundary control, which is why stateless per-request invocation is strictly enforced."
