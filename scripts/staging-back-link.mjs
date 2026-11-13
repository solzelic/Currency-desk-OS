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
  /* Back to the sign-in page, signed out on the way: /login opens a desk
     by itself when a session is still alive. */
  function back(e) {
    e.preventDefault();
    var go = function () { location.assign('/login'); };
    try { fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(go, go); } catch (x) { go(); }
  }
  function place(a) {
    /* on a phone it sits above the page's own messages at the bottom */
    var narrow = window.innerWidth < 640;
    a.style.bottom = narrow ? '88px' : '12px';
  }
  function draw() {
    if (!document.body || document.getElementById('cd-staging-back')) return;
    var a = document.createElement('a');
    a.id = 'cd-staging-back';
    a.href = '/login';
    a.textContent = 'Staging \\u00b7 Back to sign in';
    a.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:2147483000;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;background:#17140F;color:#FCFAF5;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,0.25)');
    a.addEventListener('click', back);
    place(a);
    document.body.appendChild(a);
  }
  fetch('/api/staging/signin', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || d.enabled !== true) return;
      draw();
      /* Some pages replace their whole document once they have loaded
         (the setup page does). Draw it again whenever it goes missing. */
      if (typeof MutationObserver === 'function') new MutationObserver(draw).observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', draw);
      window.addEventListener('load', draw);
      window.addEventListener('resize', function () { var a = document.getElementById('cd-staging-back'); if (a) place(a); });
    })
    .catch(function () {});
})();
</script>
`;
