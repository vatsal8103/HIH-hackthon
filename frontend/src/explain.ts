// Plain-language reading of recorded results, for people new to security testing.
// Pure functions over API data (type-only imports), so the wording is unit-tested with
// `node --test` and can never say more than the recorded data shows.
import type { CheckpointVerification, IsolationCheck, Risk, RunCase, RunDetail, Stage, TargetInfo } from "./api";

export type Tone = "good" | "warn" | "bad" | "neutral";

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-moss-300",
  warn: "text-amber-300",
  bad: "text-rust-300",
  neutral: "text-bone-200",
};

const ORDER: Stage[] = ["attack", "respond", "evaluate", "defend", "retest", "isolation", "report"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- pipeline

/** The seven real backend stages, in order, named for a newcomer. `who` is the technical role. */
export const PLAIN_STAGE: Record<Stage, { name: string; who: string; sentence: string }> = {
  attack: { name: "Attack attempt", who: "Red Team", sentence: "The tester sends scripted attack prompts to the AI." },
  respond: {
    name: "AI response",
    who: "Target",
    sentence: "The AI under test answers each prompt, behind any protections already in place.",
  },
  evaluate: {
    name: "Check the response",
    who: "Evaluator",
    sentence: "Each answer is checked against the safety rules written for its test.",
  },
  defend: {
    name: "Apply protection",
    who: "Blue Team",
    sentence: "The defender sees a redacted summary of what failed and adds protections.",
  },
  retest: { name: "Try again", who: "Retest", sentence: "The same attacks run again, so the two results can be compared." },
  isolation: {
    name: "Check the walls",
    who: "Isolation",
    sentence: "Bayora checks that each role can reach only what it is allowed to.",
  },
  report: {
    name: "Score and record",
    who: "Report · audit",
    sentence: "The remaining risk is scored and the evidence record is verified.",
  },
};

export type StageState = "waiting" | "running" | "completed" | "failed";

/** The stage the backend refused for this run, if any. Both sides may be null (no runs yet). */
export function refusedStage(failed: { runId: string; stage: Stage } | null, run: RunDetail | null): Stage | null {
  return failed && run && failed.runId === run.id ? failed.stage : null;
}

export const STATE_LABEL: Record<StageState, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

const stageDone = (run: RunDetail, stage: Stage) =>
  run.stage !== "created" && ORDER.indexOf(run.stage) >= ORDER.indexOf(stage);

/**
 * State of one stage. `failedAt` is the stage the backend refused to complete (the run
 * stays at the stage before it and can be resumed). The backend never skips a stage.
 */
export function stageState(run: RunDetail | null, playing: Stage | null, stage: Stage, failedAt: Stage | null): StageState {
  if (playing === stage) return "running";
  if (run && stageDone(run, stage)) return "completed";
  if (failedAt === stage) return "failed";
  return "waiting";
}

/** What a completed stage produced, read from the run's recorded data. */
export function stageResult(run: RunDetail, stage: Stage): { text: string; tone: Tone } | null {
  if (!stageDone(run, stage)) return null;
  const cases = run.cases;
  const failed = (phase: "baseline" | "retest") => cases.filter((c) => c[phase]?.verdict === "fail").length;
  switch (stage) {
    case "attack":
      return { text: `${plural(cases.filter((c) => c.baseline).length, "attack")} sent`, tone: "neutral" };
    case "respond":
      return { text: `${plural(cases.filter((c) => c.baseline?.response != null).length, "answer")} received`, tone: "neutral" };
    case "evaluate": {
      const n = failed("baseline");
      return n
        ? { text: `${n} of ${cases.length} broke a safety rule`, tone: "bad" }
        : { text: "No answer broke a safety rule", tone: "good" };
    }
    case "defend": {
      const added = run.defenses.length;
      if (added) return { text: `${plural(added, "protection")} added`, tone: "neutral" };
      return failed("baseline") ? { text: "No protection added", tone: "warn" } : { text: "Nothing needed fixing", tone: "neutral" };
    }
    case "retest": {
      const n = failed("retest");
      return n ? { text: `${n} still failing`, tone: "bad" } : { text: "All passed the retry", tone: "good" };
    }
    case "isolation": {
      const { tested, failures, untested } = isolationCounts(run.isolation);
      const text = failures
        ? `${failures} of ${tested} checks failed`
        : `${tested} of ${tested} checks passed${untested ? `, ${untested} not tested here` : ""}`;
      return { text, tone: failures ? "bad" : "good" };
    }
    case "report":
      return run.report ? { text: `Highest remaining risk: ${run.report.overall_risk}`, tone: riskTone(run.report.overall_risk) } : null;
  }
}

/** Checks that actually ran (app, network, container) versus declared or planned ones. */
export function isolationCounts(checks: IsolationCheck[]) {
  const ran = checks.filter((c) => c.kind === "enforced" || c.kind === "network" || c.kind === "configured");
  return {
    tested: ran.length,
    failures: ran.filter((c) => c.status === "fail").length,
    untested: checks.length - ran.length,
  };
}

// ---------------------------------------------------------------- risk

export const riskTone = (risk: Risk): Tone =>
  risk === "none" || risk === "low" ? "good" : risk === "medium" ? "warn" : "bad";

/** Mirrors pipeline.residual_risk and the criterion severities on the backend. */
export const RISK_PLAIN: Record<Risk, string> = {
  none: "No failure remained after the retry.",
  low: "Minor: a low-severity issue remains, or an attack was stopped only by a specific protection.",
  medium: "Partly fixed: a protection hid the result, but the AI itself still tried to comply.",
  high: "Serious: a rule that protects personal data, instructions or refusals still fails.",
  critical: "Most serious: confidential system data can still leak.",
};

// ---------------------------------------------------------------- one test case

export type OutcomeKey = "pending" | "resisted" | "stopped" | "masked" | "vulnerable" | "regressed";

export interface Outcome {
  key: OutcomeKey;
  label: string;
  tone: Tone;
  sentence: string;
}

/**
 * What happened to one attack, in plain words. Passing is "passed this test", never
 * "safe": one scripted attack says nothing about attacks that were not tried.
 */
export function caseOutcome(c: RunCase, ruleName: (id: string) => string = (id) => id): Outcome {
  const first = c.baseline?.verdict;
  const retry = c.retest;
  if (!first || !retry?.verdict) {
    return { key: "pending", label: "Not finished", tone: "neutral", sentence: "This test has not finished both attempts yet." };
  }
  if (retry.verdict === "fail") {
    if (first === "pass") {
      const blocker = retry.blocked_by ? ` “${ruleName(retry.blocked_by)}” blocked it on the retry.` : "";
      return {
        key: "regressed",
        label: "Failed the retry",
        tone: "bad",
        sentence: `It passed the first attempt but failed the retry.${blocker}`,
      };
    }
    return {
      key: "vulnerable",
      label: "Still vulnerable",
      tone: "bad",
      sentence: "The attack worked before the protections were added, and it still worked afterwards.",
    };
  }
  if (first === "pass") {
    return {
      key: "resisted",
      label: "Passed this test",
      tone: "good",
      sentence: "The AI did not fall for this attack on either attempt. No failure was detected in this test.",
    };
  }
  if (retry.filtered_by) {
    return {
      key: "masked",
      label: "Hidden, not fixed",
      tone: "warn",
      sentence: `The retry passed only because “${ruleName(retry.filtered_by)}” removed the leaked text from the answer. The AI itself still tried to comply.`,
    };
  }
  const rule = retry.blocked_by ?? retry.transformed_by;
  return {
    key: "stopped",
    label: rule ? "Stopped by a protection" : "Passed the retry",
    tone: "good",
    sentence: rule
      ? `The attack worked at first. On the retry, “${ruleName(rule)}” stopped it.`
      : "The attack worked at first and did not work on the retry.",
  };
}

/** What each outcome label means: the one definition shown on the overview legend and on How it works. */
export const OUTCOME_MEANING: Record<Exclude<OutcomeKey, "pending">, { label: string; tone: Tone; meaning: string }> = {
  resisted: {
    label: "Passed this test",
    tone: "good",
    meaning: "The AI did not fall for the attack on either attempt. One passed test is not proof the AI is safe.",
  },
  stopped: {
    label: "Stopped by a protection",
    tone: "good",
    meaning: "The attack worked at first; on the retry, a protection the Blue Team added prevented it.",
  },
  masked: {
    label: "Hidden, not fixed",
    tone: "warn",
    meaning: "Output filtering concealed the result on the retry, but the AI still attempted what the attack asked.",
  },
  vulnerable: {
    label: "Still vulnerable",
    tone: "bad",
    meaning: "The attack still worked after the protections were added.",
  },
  regressed: {
    label: "Failed the retry",
    tone: "bad",
    meaning: "The first attempt passed but the retry failed, for example because a protection blocked a harmless request.",
  },
};

/** Counts behind the overview cards, from one run's recorded cases. */
export function outcomeCounts(cases: RunCase[]) {
  const count = (...keys: OutcomeKey[]) => cases.filter((c) => keys.includes(caseOutcome(c).key)).length;
  return {
    total: cases.length,
    fromStart: count("resisted"),
    afterProtection: count("stopped", "masked"),
    masked: count("masked"),
    failing: count("vulnerable", "regressed"),
    pending: count("pending"),
  };
}

const RISK_RANK: Risk[] = ["none", "low", "medium", "high", "critical"];

/** The case a newcomer should look at first: the highest remaining risk, else the first fixed one. */
export function spotlightCase(run: RunDetail): RunCase | null {
  const ranked = run.cases
    .filter((c) => c.residual)
    .sort((a, b) => RISK_RANK.indexOf(b.residual!.residual_risk) - RISK_RANK.indexOf(a.residual!.residual_risk));
  const worst = ranked[0];
  if (worst && worst.residual!.residual_risk !== "none") return worst;
  return run.cases.find((c) => caseOutcome(c).key === "stopped") ?? run.cases[0] ?? null;
}

// ---------------------------------------------------------------- deployment facts

/** The demo notice, only when the backend says what the target is. */
export function targetNotice(target: TargetInfo | undefined): { tone: Tone; text: string; detail: string } | null {
  if (!target) return null;
  if (target.kind === "simulated") {
    return {
      tone: "warn",
      text: "Demo environment · The target is simulated: it uses deterministic rules and is not a live AI model.",
      detail: `${target.provider ?? "simulator"} · ${reporter(target.source)}`,
    };
  }
  if (target.kind === "unknown") {
    return {
      tone: "bad",
      text: "Target status unknown · the target service did not answer.",
      detail: target.source,
    };
  }
  return { tone: "neutral", text: `Live target · ${target.provider ?? target.kind}`, detail: reporter(target.source) };
}

const reporter = (source: string) =>
  source === "in-process"
    ? "reported by the API process, which runs the target"
    : source === "target agent"
      ? "reported by the target container"
      : source;

/** Witness checkpoint status, never stronger than what verification found. */
export function checkpointPlain(checkpoint: CheckpointVerification): { label: string; tone: Tone; sentence: string } {
  switch (checkpoint.status) {
    case "ok": {
      const pending = checkpoint.unanchored_events ?? 0;
      return pending
        ? {
            label: "Matches · newest events not yet anchored",
            tone: "warn",
            sentence: `Events up to #${checkpoint.anchored_seq} match the witness. The ${plural(pending, "newest event")} have no checkpoint yet, so a change to them would not be caught.`,
          }
        : {
            label: "Matches the witness",
            tone: "good",
            sentence: `All ${checkpoint.checkpoints} checkpoints match. Every event up to #${checkpoint.anchored_seq} is covered by a checkpoint.`,
          };
    }
    case "mismatch":
      return {
        label: "Changed since a checkpoint",
        tone: "bad",
        sentence:
          "The stored record no longer matches the witness: something checkpointed was altered or removed." +
          (checkpoint.superseded?.length
            ? ` ${plural(checkpoint.superseded.length, "checkpoint")} were superseded in an operator recovery; the mismatch stays reported.`
            : ""),
      };
    case "unavailable":
      return {
        label: "Witness unavailable",
        tone: "bad",
        sentence: "The witness could not be reached, so the record could not be compared with it.",
      };
    case "not-configured":
      return {
        label: "No witness here",
        tone: "warn",
        sentence: "No witness is configured in this deployment, so a complete rewrite of the record would not be detected.",
      };
  }
}

/** What each isolation check kind means and how it was verified. */
export const KIND_PLAIN: Record<IsolationCheck["kind"], string> = {
  enforced: "Real requests in this run: the backend allowed or refused them as its permission table says (application level).",
  network: "Probed from inside the role containers in this run: connections that must fail did fail.",
  configured: "Container settings observed from inside each role container (non-root, read-only, no extra privileges).",
  simulated: "A declared model only. Nothing was tested in this deployment.",
  planned: "Not active in this deployment.",
};

/** Every audit event type the backend writes, in plain words. Unknown types show as recorded. */
const EVENT_PLAIN: Record<string, string> = {
  "session.created": "Test started",
  "red.baseline_submitted": "Red Team sent an attack",
  "target.baseline_response": "Target answered",
  "evaluator.baseline_verdict": "Answer checked against the rules",
  "blue.findings_read": "Blue Team read the redacted findings",
  "blue.defense_applied": "Protection added",
  "red.retest_submitted": "Red Team sent the attack again",
  "target.retest_response": "Target answered the retry",
  "evaluator.retest_verdict": "Retry checked against the rules",
  "isolation.check": "Isolation check recorded",
  "report.generated": "Report generated",
  "credential.revoked": "Credential revoked",
};

export const eventPlain = (eventType: string) => EVENT_PLAIN[eventType] ?? eventType;
