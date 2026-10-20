import type { Risk, RunDetail, Stage } from "../api";

export type SceneStage = "idle" | "created" | Stage;
export type Role = "red" | "target" | "blue";

export const SCENE_ORDER: SceneStage[] = [
  "idle",
  "created",
  "attack",
  "respond",
  "evaluate",
  "defend",
  "retest",
  "isolation",
  "report",
];

/** Everything the lattice shows is read from recorded run data. */
export interface SceneData {
  cases: number;
  baselineFailures: number;
  defenses: number;
  retestBlocked: number;
  retestFailures: number;
  risk: Risk | null;
  isolationOk: boolean | null;
}

export function sceneData(run: RunDetail | null): SceneData {
  if (!run) {
    return {
      cases: 0,
      baselineFailures: 0,
      defenses: 0,
      retestBlocked: 0,
      retestFailures: 0,
      risk: null,
      isolationOk: null,
    };
  }
  const enforced = run.isolation.filter((c) => c.kind === "enforced");
  return {
    cases: run.cases.length,
    baselineFailures: run.cases.filter((c) => c.baseline?.verdict === "fail").length,
    defenses: run.defenses.length,
    retestBlocked: run.cases.filter((c) => c.retest?.blocked_by).length,
    retestFailures: run.cases.filter((c) => c.retest?.verdict === "fail").length,
    risk: run.report?.overall_risk ?? null,
    isolationOk: enforced.length ? enforced.every((c) => c.status === "pass") : null,
  };
}

export const PALETTE = {
  background: "#121210",
  bone: "#d6cfbf",
  boneBright: "#efe9dc",
  graphite: "#25241f",
  rust: "#c9705f",
  moss: "#9cae7e",
  amber: "#d1a05a",
};

export const ROLE_COPY: Record<Role, { name: string; zone: string; summary: string }> = {
  red: {
    name: "Red Team",
    zone: "The tester",
    summary: "Submits attacks and sees its own outcomes. Never sees findings or which defense acted.",
  },
  target: {
    name: "Target",
    zone: "System under test",
    summary: "Receives prompt text only. No attack labels, criteria, defenses or audit access.",
  },
  blue: {
    name: "Blue Team",
    zone: "The defender",
    summary: "Reads redacted findings and applies rules. Never sees attack prompts.",
  },
};
