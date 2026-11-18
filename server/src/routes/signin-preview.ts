/* Design review for the sign-in frames. Fake data, no auth calls.
   The page is served only for the staging host named below, or for
   localhost. Every other host, including the live site, is 404.
   x-forwarded-host is not a host. */
import type { FastifyInstance } from "fastify";
import { requestHost } from "../auth/staging-runtime.js";

export const SIGNIN_PREVIEW_STAGING_HOST = "currencydesk-staging.onrender.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const SIGNIN_PREVIEW_STATES = ["a", "a2", "b", "c", "d", "e", "f", "g", "g2", "h"] as const;

export function signInPreviewHostAllowed(host: string | string[] | undefined): boolean {
  const raw = (Array.isArray(host) ? host[0] : host) ?? "";
  const text = String(raw).trim().toLowerCase();
  if (text === "[::1]" || text.startsWith("[::1]:")) return true;
  const name = requestHost(host);
  if (!name) return false;
  if (name === SIGNIN_PREVIEW_STAGING_HOST) return true;
  return LOCAL_HOSTS.has(name);
}

function robots(reply: { header: (k: string, v: string) => void }): void {
  reply.header("x-robots-tag", "noindex, nofollow");
  reply.header("cache-control", "no-store");
}

function deny(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): unknown {
  return reply.code(404).send({ error: "not_found" });
}

const INDEX = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign-in preview</title>
</head>
<body>
<main>
<h1>Sign-in preview</h1>
<p>These screens use fake data. They do not sign anyone in.</p>
<ul>
<li><a href="/design-preview/signin/a">A Sign in</a></li>
<li><a href="/design-preview/signin/a2">A2 Password step</a></li>
<li><a href="/design-preview/signin/b">B Waiting for passkey</a></li>
<li><a href="/design-preview/signin/c">C No passkey on this device</a></li>
<li><a href="/design-preview/signin/d">D Owner confirm</a></li>
<li><a href="/design-preview/signin/e">E Teller PIN</a></li>
<li><a href="/design-preview/signin/f">F Pick a shop</a></li>
<li><a href="/design-preview/signin/g">G Passkey setup</a></li>
<li><a href="/design-preview/signin/g2">G2 Passkey ready</a></li>
<li><a href="/design-preview/signin/h">H Sign-in methods</a></li>
</ul>
</main>
</body>
</html>
`;

const STATE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign-in preview</title>
<link rel="stylesheet" href="/web/fonts/fonts.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet">
<style>html,body{margin:0;background:#F7F4ED}</style>
</head>
<body>
<div id="root"></div>
<script src="/web/vendor/react.production.min.js"></script>
<script src="/web/vendor/react-dom.production.min.js"></script>
<script src="/web/app/signin-preview.js"></script>
<script>
(function () {
  var parts = location.pathname.split("/").filter(Boolean);
  var state = (parts[2] || "a").toLowerCase();
  var q = new URLSearchParams(location.search);
  ReactDOM.createRoot(document.getElementById("root")).render(
    React.createElement(window.CDOS.SignInPreview, {
      state: state,
      device: q.get("d") || "",
      motion: q.get("motion") || "still"
    })
  );
})();
</script>
</body>
</html>
`;

export function registerSignInPreviewRoutes(app: FastifyInstance): void {
  const guard = (host: string | string[] | undefined, reply: { code: (n: number) => { send: (b: unknown) => unknown }; header: (k: string, v: string) => void }) => {
    if (!signInPreviewHostAllowed(host)) return deny(reply);
    robots(reply);
    return null;
  };

  app.get("/design-preview/signin", async (req, reply) => {
    const blocked = guard(req.headers.host, reply);
    if (blocked) return blocked;
    return reply.type("text/html; charset=utf-8").send(INDEX);
  });

  app.get("/design-preview/signin/", async (req, reply) => {
    const blocked = guard(req.headers.host, reply);
    if (blocked) return blocked;
    return reply.type("text/html; charset=utf-8").send(INDEX);
  });

  app.get("/design-preview/signin/:state", async (req, reply) => {
    const blocked = guard(req.headers.host, reply);
    if (blocked) return blocked;
    const state = String((req.params as { state?: string }).state || "").toLowerCase();
    if (!SIGNIN_PREVIEW_STATES.includes(state as (typeof SIGNIN_PREVIEW_STATES)[number])) {
      return deny(reply);
    }
    return reply.type("text/html; charset=utf-8").send(STATE_PAGE);
  });

  app.get("/design-preview", async (_req, reply) => deny(reply));
  app.get("/design-preview/*", async (_req, reply) => deny(reply));
}
