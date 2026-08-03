/* ============================================================
   Tailwind, at build time — the config the Play CDN never had.

   The OS shipped with <script src="https://cdn.tailwindcss.com"> — the
   Play CDN, a full Tailwind COMPILER running in the customer's browser,
   scanning the DOM and generating CSS on every load. Tailwind's own
   documentation says never to ship it. It was also the last off-domain
   request standing between a teller and their till: we watched the OS
   open with that host blocked, and the sign-in screen survived on
   york-os.css while everything behind it would not have — 4,070
   className usages lean on these utilities.

   So the same classes are compiled HERE, once, into web/app/tw.css, and
   the built shell links that instead. The source shell keeps the CDN tag
   so the buildless dev flow (open the HTML, edit, refresh) still works
   with no build step — the exact arrangement Babel and React already
   have in scripts/build-os.mjs.

   No theme extensions on purpose: the page never set an inline
   `tailwind.config`, so the defaults the CDN used are the defaults here.
   The OS styles itself with arbitrary values (text-[11px], bg-[#faf8f4])
   rather than a theme, and the JIT scanner picks those out of the JSX
   sources as plain strings.

   KNOWN LIMIT: the scanner only finds class names that appear whole in
   the sources. A class assembled at runtime ("text-" + size) would be
   missed — checked before this landed: there are none, and the visual
   verification in the build would catch one growing back.
   ============================================================ */
module.exports = {
  content: [
    // everything the OS shell runs, in source form
    "./CurrencyDesk OS.html",
    "./os-src/**/*.{jsx,js}",
  ],
  theme: { extend: {} },
  corePlugins: {
    /* The Play CDN applied its base reset (preflight), and york-os.css was
       written on top of it. Keep it, or every margin the reset removed
       comes back. */
    preflight: true,
  },
};
