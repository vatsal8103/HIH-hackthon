// Run with `npm test`. The API client must turn every failure into an error, never into empty data.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ApiError, api } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown) {
  globalThis.fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
    });
}

test("a proxy answering for a stopped API reads as 'not answering', not as no data", async () => {
  respond(502, "Bad Gateway");
  await assert.rejects(api.runs(), (err: ApiError) => err.status === 502 && /not answering/.test(err.message));
});

test("the backend's own error detail is kept", async () => {
  respond(502, { detail: "Role service failure: blue agent unreachable" });
  await assert.rejects(api.advance("x"), /Role service failure: blue agent unreachable/);
  respond(404, { detail: "Session not found" });
  await assert.rejects(api.run("missing"), (err: ApiError) => err.status === 404 && err.message === "Session not found");
});

test("an unexpected 200 body is an error, never an empty list or an 'intact' record", async () => {
  respond(200, { runs: [] });
  await assert.rejects(api.runs(), /unexpected run list/);
  respond(200, { checked: 3, errors: [] });
  await assert.rejects(api.verify(), /unexpected verification result/);
  respond(200, { ok: "yes", checked: 3, errors: [] });
  await assert.rejects(api.verify(), /unexpected verification result/);
});

test("well-formed responses pass through unchanged", async () => {
  respond(200, []);
  assert.deepEqual(await api.runs(), []);
  respond(200, { ok: false, checked: 9, errors: [{ seq: 4, kind: "hash", message: "x" }], head_hash: "h" });
  assert.equal((await api.verify()).ok, false);
});

test("an unreachable API reads as such", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(api.meta(), (err: ApiError) => err.status === 0 && /Cannot reach/.test(err.message));
});

test("threatModel API validates well-formed and unexpected responses", async () => {
  respond(200, { markdown: "# Threat Model", threats: [] });
  const model = await api.threatModel();
  assert.equal(model.markdown, "# Threat Model");
  assert.deepEqual(model.threats, []);

  respond(200, { invalid: true });
  await assert.rejects(api.threatModel(), /unexpected threat model response/);
});

