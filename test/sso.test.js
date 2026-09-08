"use strict";
/* Integration tests for the Microsoft SSO wiring. These spawn the real server
 * as a child process (SSO on / off) and exercise the HTTP surface, since the
 * SSO logic lives in server routes rather than an importable module. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const SERVER = path.join(__dirname, "..", "server.js");

/* Start server.js with the given extra env on a fresh temp data dir and a
 * unique port; resolve once it is accepting connections. */
async function startServer(extraEnv, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wssp-sso-"));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", (b) => {
      if (String(b).includes("running at")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error("server exited early: " + c)); });
  });
  return {
    child,
    base: "http://localhost:" + port,
    stop() { try { child.kill(); } catch (e) { /* already gone */ } fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
}

test("SSO disabled: /api/me reports no Microsoft sign-in and login route 404s", async () => {
  const s = await startServer({}, 5711);
  try {
    const me = await (await fetch(s.base + "/api/me")).json();
    assert.equal(me.microsoftSso, false);
    assert.equal(me.microsoftSsoUrl, null);
    const login = await fetch(s.base + "/auth/sso/login", { redirect: "manual" });
    assert.equal(login.status, 404);
  } finally { s.stop(); }
});

test("SSO enabled: /api/me advertises the MSAL login URL", async () => {
  const s = await startServer({
    AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_SECRET: "fake-secret",
    AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222"
  }, 5712);
  try {
    const me = await (await fetch(s.base + "/api/me")).json();
    assert.equal(me.microsoftSso, true);
    assert.equal(me.microsoftSsoUrl, "/auth/sso/login");
  } finally { s.stop(); }
});

test("SSO enabled: /auth/sso/login redirects to Microsoft with PKCE + state cookie", async () => {
  const s = await startServer({
    AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_SECRET: "fake-secret",
    AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222"
  }, 5713);
  try {
    const res = await fetch(s.base + "/auth/sso/login", { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") || "";
    assert.match(loc, /login\.microsoftonline\.com\/22222222-2222-2222-2222-222222222222/);
    assert.match(loc, /code_challenge=/);
    assert.match(loc, /code_challenge_method=S256/);
    assert.match(loc, /state=/);
    assert.match(loc, /redirect_uri=.*%2Fauth%2Fsso%2Fcallback/);
    assert.match(res.headers.get("set-cookie") || "", /wssp_sso_tx=/);
  } finally { s.stop(); }
});

test("SSO enabled: callback with a mismatched state is rejected (CSRF guard)", async () => {
  const s = await startServer({
    AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_SECRET: "fake-secret",
    AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222"
  }, 5714);
  try {
    const res = await fetch(s.base + "/auth/sso/callback?code=abc&state=not-the-real-state", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/?sso_error=1");
  } finally { s.stop(); }
});
