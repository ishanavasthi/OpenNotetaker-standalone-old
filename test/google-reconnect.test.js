// Reconnecting a Google account whose grant went bad: boot the real server with Google's
// endpoints faked in-process, let the calendar scheduler flag the account, reconnect it,
// and check what the user sees next.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

// Preloaded into the server process. The first code exchange hands back a grant with no
// refresh token that has already expired — the state a revoked or lapsed connection ends
// up in — so the first calendar sync fails with no_refresh_token. Every later exchange (the
// reconnect) is a healthy grant.
const FAKE_GOOGLE = `
const realFetch = globalThis.fetch;
let exchanges = 0;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://oauth2.googleapis.com/token") {
    const params = new URLSearchParams(String(init?.body || ""));
    if (params.get("grant_type") !== "authorization_code") return json({ error: "invalid_grant" }, 400);
    exchanges += 1;
    const scope = "openid email ${CALENDAR_SCOPE}";
    return json(exchanges === 1
      ? { access_token: "stale", scope, token_type: "Bearer" }
      : { access_token: "fresh", refresh_token: "refresh", expires_in: 3600, scope, token_type: "Bearer" });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return json({ sub: "google-sub-1", email: "owner@example.com", email_verified: true, name: "Owner" });
  }
  if (url.startsWith("https://www.googleapis.com/calendar/v3/")) return json({ items: [] });
  return realFetch(input, init);
};
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "opennotetaker-reconnect-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(FAKE_GOOGLE)}`, join(rootDir, "src", "server.js")],
    {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: "127.0.0.1",
        BOT_PROVIDER: "fleet",
        LLM_PROVIDER: "mock",
        RUNNER_TOKEN: "reconnect-test-token",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: `${baseUrl}/api/gmail/oauth/callback`,
        GOOGLE_CALENDAR_SYNC_ENABLED: "true",
        GOOGLE_CALENDAR_POLL_SECONDS: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    baseUrl,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function signUp(baseUrl, email) {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", name: "Owner" })
  });
  assert.equal(response.status, 201, `signup failed: ${await response.text()}`);
  return (response.headers.getSetCookie?.() || []).map((value) => value.split(";")[0]).join("; ");
}

// Walks the browser's half of the OAuth dance: start (which mints the state), then the
// callback Google would have redirected to. Returns the callback response unfollowed.
async function connectGoogle(baseUrl, cookie) {
  const start = await fetch(`${baseUrl}/api/gmail/oauth/start`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  return fetch(`${baseUrl}/api/gmail/oauth/callback?state=${state}&code=auth-code`, {
    headers: { Cookie: cookie },
    redirect: "manual"
  });
}

async function accounts(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/google/accounts`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).accounts;
}

async function waitFor(check, what) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("reconnecting a flagged Google account clears 'reconnect needed' and lands back in the app", async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const cookie = await signUp(server.baseUrl, "owner@example.com");

  const first = await connectGoogle(server.baseUrl, cookie);
  assert.ok(first.status < 400, `first connect failed: ${await first.text()}`);

  await waitFor(
    async () => (await accounts(server.baseUrl, cookie))[0]?.needsReconnect === true,
    "the scheduler to flag the expired grant"
  );

  const reconnect = await connectGoogle(server.baseUrl, cookie);
  // Straight away — not after the next scheduler tick.
  const [account] = await accounts(server.baseUrl, cookie);
  assert.equal(account.needsReconnect, false, "a fresh grant still shows 'reconnect needed'");

  // Reconnect is a same-tab link, so the callback has to bring the user back to the app
  // rather than strand them on a "close this tab" page with no other tab to return to.
  assert.equal(reconnect.status, 302, "callback should redirect back into the app");
  assert.equal(new URL(reconnect.headers.get("location"), server.baseUrl).pathname, "/");
});
