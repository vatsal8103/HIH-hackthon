from conftest import auth, run_to_completion


def test_rejects_unknown_or_empty_attack_selection(client):
    assert (
        client.post("/api/runs", json={"attack_ids": ["XX-99"]}, headers=auth("operator")).status_code == 422
    )
    assert client.post("/api/runs", json={"attack_ids": []}, headers=auth("operator")).status_code == 422


def test_unknown_session_returns_404(client):
    assert client.get("/api/runs/nope", headers=auth("operator")).status_code == 404
    assert client.post("/api/runs/nope/advance", headers=auth("operator")).status_code == 404
    assert client.get("/api/blue/sessions/nope/findings", headers=auth("blue")).status_code == 404


def test_advancing_a_completed_run_conflicts(client):
    run = run_to_completion(client, ["BN-00"])
    assert client.post(f"/api/runs/{run['id']}/advance", headers=auth("operator")).status_code == 409


def test_stage_guards_on_role_actions(client):
    run = client.post("/api/runs", json={"attack_ids": ["PI-01"]}, headers=auth("operator")).json()
    sid = run["id"]

    # Blue cannot defend before anything has been evaluated.
    early = client.post(
        f"/api/blue/sessions/{sid}/defenses", json={"rule_id": "instruction-guard"}, headers=auth("blue")
    )
    assert early.status_code == 409

    # Red cannot resubmit the same case, nor submit after the target has responded.
    client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))
    duplicate = client.post(
        f"/api/red/sessions/{sid}/attempts", json={"attack_id": "PI-01"}, headers=auth("red")
    )
    assert duplicate.status_code == 409
    client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))
    late = client.post(f"/api/red/sessions/{sid}/attempts", json={"attack_id": "JB-02"}, headers=auth("red"))
    assert late.status_code == 409


def test_blue_can_apply_extra_rule_in_window(client):
    run = client.post("/api/runs", json={"attack_ids": ["OB-03"]}, headers=auth("operator")).json()
    sid = run["id"]
    for _ in range(3):  # attack, respond, evaluate
        client.post(f"/api/runs/{sid}/advance", headers=auth("operator"))

    applied = client.post(
        f"/api/blue/sessions/{sid}/defenses", json={"rule_id": "decode-scan"}, headers=auth("blue")
    )
    assert applied.json() == {"rule_id": "decode-scan", "applied": True}
    assert (
        client.post(
            f"/api/blue/sessions/{sid}/defenses", json={"rule_id": "nope"}, headers=auth("blue")
        ).status_code
        == 404
    )

    while run["next_stage"]:
        run = client.post(f"/api/runs/{sid}/advance", headers=auth("operator")).json()["run"]
    assert run["cases"][0]["retest"]["blocked_by"] == "decode-scan"
    assert run["report"]["overall_risk"] == "low"


def test_tamper_simulation_needs_events(client):
    response = client.post("/api/audit/tamper-test", json={"mode": "modify"}, headers=auth("operator"))
    assert response.status_code == 400
    assert (
        client.post("/api/audit/tamper-test", json={"mode": "explode"}, headers=auth("operator")).status_code
        == 422
    )
