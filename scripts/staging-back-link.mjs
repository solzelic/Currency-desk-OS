/* Staging only: a way back to the sign-in page from every page of the
   journey (Sol, 14 Nov: "I should always be able to go back to that login
   page"). The sign-in page is where "Start a fresh shop" lives.

   It runs only on a staging hostname, so live never asks, and it draws
   only when the server's staging door answers GET /api/staging/signin
   with { enabled: true } (routes/staging-signin.ts), the same question
   the sign-in page asks before it shows its staging buttons. Injected by
   scripts/build-site.mjs and scripts/build-onboarding.mjs. */
export const STAGING_BACK_LINK = `<script>
(function () {
  if (!/staging/i.test(location.hostname)) return;
  function draw() {
    if (document.getElementById('cd-staging-back')) return;
    var a = document.createElement('a');
    a.id = 'cd-staging-back';
    a.href = '/login';
    a.textContent = 'Staging \\u00b7 Back to sign in';
    a.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:2147483000;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;background:#17140F;color:#FCFAF5;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,0.25)');
    document.body.appendChild(a);
  }
  fetch('/api/staging/signin', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || d.enabled !== true) return;
      if (document.body) draw(); else document.addEventListener('DOMContentLoaded', draw);
    })
    .catch(function () {});
})();
</script>
`;
