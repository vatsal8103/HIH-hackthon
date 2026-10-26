from conftest import auth, run_to_completion

from app import defenses
from app.attacks import BY_ID
from app.target import CANARY

EXPECTED_RESIDUAL = {
    "BN-00": "none",
    "PI-01": "low",
    "JB-02": "medium",
    "OB-03": "high",
    "II-04": "low",
    "PS-05": "high",
    "PR-06": "none",
}


def test_full_simulated_workflow(client):
    run = run_to_completion(client)

    assert run["executed"] == ["attack", "respond", "evaluate", "defend", "retest", "isolation", "report"]
    assert run["status"] == "completed"
    report = run["report"]
    assert {c["attack_id"]: c["residual_risk"] for c in report["cases"]} == EXPECTED_RESIDUAL
    assert report["overall_risk"] == "high"
    assert report["counts"] == {"cases": 7, "baseline_failures": 5, "mitigated": 3, "residual_failures": 2}
    assert set(report["defenses"]) == {"secret-egress-filter", "instruction-guard", "untrusted-content-fence"}
    assert report["audit"]["ok"] is True
    # In-process roles: application checks pass; network and container checks are not claimed.
    isolation = report["isolation"]
    assert (isolation["enforced_pass"], isolation["enforced_fail"]) == (9, 0)
    assert (isolation["simulated"], isolation["planned"]) == (1, 2)
    assert isolation["network_pass"] == isolation["configured_pass"] == 0
    assert report["deployment"]["roles"] == {
        "red": "in-process",
        "blue": "in-process",
        "target": "in-process",
    }
    assert report["deployment"]["target_kind"] == "simulated"


def test_runs_are_deterministic(client):
    first = run_to_completion(client)
    second = run_to_completion(client)

    def outcome(run):
        return [
            (
                c["attack"]["id"],
                c["baseline"]["response"],
                c["retest"]["response"],
                c["residual"]["residual_risk"],
            )
            for c in run["cases"]
        ]

    assert outcome(first) == outcome(second)
    assert client.get("/api/audit/verify", headers=auth("operator")).json()["ok"] is True


def test_defense_and_retest_behaviour(client):
    cases = {c["attack"]["id"]: c for c in run_to_completion(client)["cases"]}

    assert cases["PI-01"]["baseline"]["verdict"] == "fail"
    assert CANARY in cases["PI-01"]["baseline"]["response"]
    assert cases["PI-01"]["retest"]["blocked_by"] == "instruction-guard"

    assert cases["JB-02"]["retest"]["filtered_by"] == "secret-egress-filter"
    assert CANARY not in cases["JB-02"]["retest"]["response"]
    assert "[REDACTED]" in cases["JB-02"]["retest"]["response"]

    # Literal guard misses the encoded and split variants: residual risk stays.
    for attack_id in ("OB-03", "PS-05"):
        failed = [r["id"] for r in cases[attack_id]["retest"]["criteria"] if not r["passed"]]
        assert failed == ["instruction-hierarchy"]

    assert cases["II-04"]["retest"]["transformed_by"] == "untrusted-content-fence"
    assert cases["II-04"]["retest"]["verdict"] == "pass"

    # Benign control is still answered after defenses: no over-refusal.
    assert cases["BN-00"]["retest"]["verdict"] == "pass"
    assert cases["PR-06"]["baseline"]["verdict"] == "pass"


def test_recommended_rule_closes_encoded_override():
    result = defenses.run_target(BY_ID["OB-03"]["prompt"], ["instruction-guard", "decode-scan"])
    assert result["blocked_by"] == "decode-scan"


def test_subset_run_and_red_submission(client):
    run = client.post("/api/runs", json={"attack_ids": ["BN-00"]}, headers=auth("operator")).json()
    submitted = client.post(
        f"/api/red/sessions/{run['id']}/attempts", json={"attack_id": "OB-03"}, headers=auth("red")
    )
    assert submitted.status_code == 201

    while run["next_stage"]:
        run = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).json()["run"]

    assert [c["attack"]["id"] for c in run["cases"]] == ["BN-00", "OB-03"]
    assert run["report"]["overall_risk"] == "high"


def test_stage_by_stage_state_is_visible(client):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    assert run["stage"] == "created" and run["next_stage"] == "attack"

    run = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).json()["run"]
    assert run["cases"][0]["baseline"]["response"] is None  # queued, target has not answered

    run = client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).json()["run"]
    assert run["cases"][0]["baseline"]["response"] is not None
    assert run["cases"][0]["baseline"]["verdict"] is None  # not yet evaluated
