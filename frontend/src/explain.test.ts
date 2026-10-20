// Run with `npm test` (node --test; Node strips the types, no extra dependency).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Attempt, CheckpointVerification, RunCase, RunDetail } from "./api";
import {
  OUTCOME_MEANING,
  caseOutcome,
  checkpointPlain,
  outcomeCounts,
  refusedStage,
  spotlightCase,
  stageResult,
  stageState,
  targetNotice,
} from "./explain.ts";

function attempt(phase: Attempt["phase"], verdict: Attempt["verdict"], guard: Partial<Attempt> = {}): Attempt {
  return {
    id: `${phase}-id`,
    attack_id: "PI-01",
    phase,
    prompt: "p",
    response: verdict ? "r" : null,
    blocked_by: null,
    filtered_by: null,
    transformed_by: null,
    verdict,
    criteria: null,
    created_at: "2026-10-21T00:00:00Z",
    ...guard,
  };
}

function testCase(id: string, first: Attempt["verdict"] | undefined, retry: Attempt["verdict"] | undefined, guard: Partial<Attempt> = {}, risk?: string): RunCase {
  return {
    attack: { id, title: id, technique: "t", objective: "o", prompt: "p", criteria: [], recommendation: "r" },
    baseline: first === undefined ? null : attempt("baseline", first),
    retest: retry === undefined ? null : attempt("retest", retry, guard),
    residual: risk
      ? {
          attack_id: id,
          title: id,
          technique: "t",
          baseline_verdict: first!,
          retest_verdict: retry!,
          residual_risk: risk as never,
          rationale: "",
          recommendation: null,
        }
      : null,
  };
}

const names = (id: string) => ({ "instruction-guard": "Instruction-override guard", "secret-egress-filter": "Secret egress filter" })[id] ?? id;

test("a pass on both attempts is 'passed this test', never 'safe'", () => {
  const outcome = caseOutcome(testCase("BN-00", "pass", "pass"));
  assert.equal(outcome.key, "resisted");
  assert.equal(outcome.label, "Passed this test");
  assert.doesNotMatch(outcome.sentence + outcome.label, /\bsafe\b/i);
});

test("an input block that fixed a failure names the protection", () => {
  const outcome = caseOutcome(testCase("PI-01", "fail", "pass", { blocked_by: "instruction-guard" }), names);
  assert.equal(outcome.key, "stopped");
  assert.match(outcome.sentence, /Instruction-override guard/);
});

test("an output filter hiding a leak is reported as hidden, not fixed", () => {
  const outcome = caseOutcome(testCase("JB-02", "fail", "pass", { filtered_by: "secret-egress-filter" }), names);
  assert.equal(outcome.key, "masked");
  assert.equal(outcome.tone, "warn");
  assert.match(outcome.sentence, /still tried/);
});

test("failures on the retry are never softened", () => {
  assert.equal(caseOutcome(testCase("OB-03", "fail", "fail")).key, "vulnerable");
  const regressed = caseOutcome(testCase("BN-00", "pass", "fail", { blocked_by: "instruction-guard" }), names);
  assert.equal(regressed.key, "regressed");
  assert.equal(regressed.tone, "bad");
  assert.match(regressed.sentence, /Instruction-override guard/);
});

test("unfinished cases are pending", () => {
  assert.equal(caseOutcome(testCase("PI-01", "fail", undefined)).key, "pending");
  assert.equal(caseOutcome(testCase("PI-01", null, null)).key, "pending");
});

test("counts add up from recorded outcomes", () => {
  const counts = outcomeCounts([
    testCase("A", "pass", "pass"),
    testCase("B", "fail", "pass", { blocked_by: "x" }),
    testCase("C", "fail", "pass", { filtered_by: "y" }),
    testCase("D", "fail", "fail"),
    testCase("E", "pass", "fail"),
  ]);
  assert.deepEqual(counts, { total: 5, fromStart: 1, afterProtection: 2, masked: 1, failing: 2, pending: 0 });
});

function run(stage: RunDetail["stage"], cases: RunCase[], extra: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run",
    created_at: "2026-10-21T00:00:00Z",
    stage,
    next_stage: null,
    status: stage === "report" ? "completed" : "running",
    cases,
    defenses: [],
    isolation: [],
    report: null,
    ...extra,
  };
}

test("stage states follow the recorded stage, the playing stage and a refused stage", () => {
  const r = run("evaluate", [testCase("A", "fail", undefined)]);
  assert.equal(stageState(null, null, "attack", null), "waiting");
  assert.equal(stageState(r, null, "respond", null), "completed");
  assert.equal(stageState(r, "evaluate", "evaluate", null), "running");
  assert.equal(stageState(r, null, "defend", "defend"), "failed");
  assert.equal(stageState(r, null, "retest", "defend"), "waiting");
});

test("stage results report failures plainly and say when nothing was fixed", () => {
  const failing = run("defend", [testCase("A", "fail", undefined)]);
  assert.deepEqual(stageResult(failing, "evaluate"), { text: "1 of 1 broke a safety rule", tone: "bad" });
  assert.deepEqual(stageResult(failing, "defend"), { text: "No protection added", tone: "warn" });
  assert.equal(stageResult(failing, "retest"), null); // not executed yet

  const isolation = run("isolation", [], {
    isolation: [
      { check_id: "ISO-01", title: "", kind: "enforced", status: "pass", detail: "" },
      { check_id: "ISO-06", title: "", kind: "network", status: "fail", detail: "" },
      { check_id: "ISO-07", title: "", kind: "planned", status: "not-run", detail: "" },
    ],
  });
  assert.deepEqual(stageResult(isolation, "isolation"), { text: "1 of 2 checks failed", tone: "bad" });
});

test("the spotlight is the highest remaining risk", () => {
  const r = run("report", [
    testCase("A", "pass", "pass", {}, "none"),
    testCase("B", "fail", "pass", { filtered_by: "y" }, "medium"),
    testCase("C", "fail", "fail", {}, "critical"),
  ]);
  assert.equal(spotlightCase(r)?.attack.id, "C");
});

test("the demo notice appears only when the backend reports what the target is", () => {
  assert.equal(targetNotice(undefined), null);
  assert.match(targetNotice({ provider: "bayora-simulator/rules-v1", kind: "simulated", source: "in-process" })!.text, /simulated/);
  assert.match(targetNotice({ provider: null, kind: "unknown", source: "target agent unreachable" })!.text, /unknown/);
  assert.doesNotMatch(targetNotice({ provider: "acme/llm", kind: "live", source: "target agent" })!.text, /simulated/);
});

test("checkpoint wording distinguishes anchored, not yet anchored, broken, unavailable and absent", () => {
  const base: CheckpointVerification = { status: "ok", checkpoints: 3, anchored_seq: 10, head_seq: 10, unanchored_events: 0, errors: [] };
  assert.equal(checkpointPlain(base).tone, "good");
  const pending = checkpointPlain({ ...base, head_seq: 12, unanchored_events: 2 });
  assert.equal(pending.tone, "warn");
  assert.match(pending.sentence, /2 newest events/);
  assert.equal(checkpointPlain({ ...base, status: "mismatch" }).tone, "bad");
  assert.equal(checkpointPlain({ ...base, status: "unavailable" }).tone, "bad");
  assert.match(checkpointPlain({ ...base, status: "not-configured" }).sentence, /would not be detected/);
});

test("a refused stage is matched to its own run, and nothing is matched when there are no runs", () => {
  const r = run("evaluate", []);
  assert.equal(refusedStage(null, null), null); // regression: crashed the empty overview
  assert.equal(refusedStage(null, r), null);
  assert.equal(refusedStage({ runId: "other", stage: "defend" }, r), null);
  assert.equal(refusedStage({ runId: "run", stage: "defend" }, r), "defend");
});

test("outcome labels and their one shared definition agree", () => {
  const cases = {
    resisted: testCase("A", "pass", "pass"),
    stopped: testCase("B", "fail", "pass", { blocked_by: "x" }),
    masked: testCase("C", "fail", "pass", { filtered_by: "y" }),
    vulnerable: testCase("D", "fail", "fail"),
    regressed: testCase("E", "pass", "fail"),
  } as const;
  for (const [key, item] of Object.entries(cases)) {
    const outcome = caseOutcome(item);
    assert.equal(outcome.key, key);
    assert.equal(outcome.label, OUTCOME_MEANING[key as keyof typeof cases].label);
    assert.equal(outcome.tone, OUTCOME_MEANING[key as keyof typeof cases].tone);
  }
});

test("the simulated-target notice says deterministic rules, not a live AI model", () => {
  const notice = targetNotice({ provider: "bayora-simulator/rules-v1", kind: "simulated", source: "target agent" })!;
  assert.match(notice.text, /deterministic rules/);
  assert.match(notice.text, /not a live AI model/);
});
