/* ============================================================
   CurrencyDesk OS — base layer
   Palette, icons, seed data, helpers, and the rate bridge that
   connects the back office to the live rate engine (yorkfx-converter.js).
   Everything is hung off window.CDOS so the other babel files can read it.
   ============================================================ */
(function () {
  const { useState } = React;

  /* black/white "Rate Board" palette + semantic compliance colors.
     Every CD value is a CSS custom property so the whole OS can re-skin
     (light / dark) by flipping ONE attribute on <html> — no component
     needs to know which theme is active. The literal values live in
     CD_THEMES; injectThemeVars() writes them as --cd-* tokens. */
  const CD_THEMES = {
    light: {
      ink: '#0a0a0a', inkSoft: '#171717', inkStrong: '#000000',
      onInk: '#ffffff', onInkSoft: 'rgba(255,255,255,0.65)', onInkFaint: 'rgba(255,255,255,0.22)',
      desk: '#e6e4de', paper: '#f4f3f0', paperSoft: '#faf9f6', panel: '#ffffff',
      chip: '#f1f0ec', chipDeep: '#e3e0d8',
      line: 'rgba(10,10,10,0.14)', lineSoft: 'rgba(10,10,10,0.07)',
      text: '#0a0a0a', mute: 'rgba(10,10,10,0.55)', faint: 'rgba(10,10,10,0.4)',
      hoverSoft: 'rgba(10,10,10,0.04)', hover: 'rgba(10,10,10,0.06)', hoverStrong: 'rgba(10,10,10,0.10)',
      shade: 'rgba(10,10,10,0.22)', scrim: 'rgba(10,10,10,0.5)', disabled: '#bdbcb3',
      brass: '#9a7406', brassSoft: '#f3e7c8', brassText: '#6b5119',   /* amber accent (sparingly) */
      flag: '#c0392b', flagSoft: '#f7e1dd',
      green: '#1f8a4c', greenSoft: '#dcefe4',
      amber: '#9a6b1f', amberSoft: '#f5e8cf'
    },
    /* warm charcoal night surface — ink flips to warm white, the colour
       accents brighten a step so they hold contrast on dark panels, and
       "soft" tints become translucent washes of their accent. */
    dark: {
      ink: '#eceae3', inkSoft: '#dedbd2', inkStrong: '#ffffff',
      onInk: '#131210', onInkSoft: 'rgba(19,18,16,0.66)', onInkFaint: 'rgba(19,18,16,0.26)',
      desk: '#131210', paper: '#161513', paperSoft: '#1a1917', panel: '#1e1d1a',
      chip: '#262521', chipDeep: '#2f2d28',
      line: 'rgba(255,255,255,0.16)', lineSoft: 'rgba(255,255,255,0.08)',
      text: '#eceae3', mute: 'rgba(236,234,227,0.58)', faint: 'rgba(236,234,227,0.4)',
      hoverSoft: 'rgba(255,255,255,0.05)', hover: 'rgba(255,255,255,0.07)', hoverStrong: 'rgba(255,255,255,0.12)',
      shade: 'rgba(255,255,255,0.24)', scrim: 'rgba(0,0,0,0.62)', disabled: '#514f47',
      brass: '#d9a92c', brassSoft: 'rgba(217,169,44,0.16)', brassText: '#e5c56a',
      flag: '#e0604f', flagSoft: 'rgba(224,96,79,0.15)',
      green: '#36ad6d', greenSoft: 'rgba(54,173,109,0.15)',
      amber: '#d99c3f', amberSoft: 'rgba(217,156,63,0.15)'
    }
  };
  const cdVar = (k) => 'var(--cd-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ')';
  const CD = {}; Object.keys(CD_THEMES.light).forEach(k => { CD[k] = cdVar(k); });

  /* ---- theme controller: persisted per device, applied on <html> ---- */
  const THEME_KEY = 'cdos_theme';
  const themePref = () => { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; } };
  const resolveTheme = (p) => p === 'auto'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (p === 'dark' ? 'dark' : 'light');
  const applyTheme = (p) => {
    const t = resolveTheme(p || themePref());
    document.documentElement.setAttribute('data-cdtheme', t);
    document.documentElement.style.colorScheme = t;   /* native controls, scrollbars */
  };
  const setThemePref = (p) => { try { localStorage.setItem(THEME_KEY, p); } catch (e) {} applyTheme(p); try { window.dispatchEvent(new CustomEvent('cdos-theme', { detail: { pref: p, resolved: resolveTheme(p) } })); } catch (e) {} };
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme('auto'); }); } catch (e) {} }

  /* write the token sets once. `.cd-paper-island` re-pins the light values on
     a subtree — used for surfaces that simulate PRINT (receipts, sealed report
     paper) so they stay paper-white even in dark mode. */
  (function injectThemeVars() {
    const decl = (t) => Object.keys(t).map(k => '  --cd-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ': ' + t[k] + ';').join('\n');
    const el = document.createElement('style');
    el.id = 'cdos-theme-vars';
    el.textContent =
      ':root {\n' + decl(CD_THEMES.light) + '\n}\n' +
      'html[data-cdtheme="dark"] {\n' + decl(CD_THEMES.dark) + '\n}\n' +
      'html[data-cdtheme="dark"] .cd-paper-island {\n' + decl(CD_THEMES.light) + '\n  color-scheme: light;\n}\n' +
      /* Tailwind's .text-white sits on CD.ink / accent buttons all over the
         modules; in dark mode those backgrounds turn light, so the label
         flips to the on-ink token. Paper islands keep true white. */
      'html[data-cdtheme="dark"] .text-white { color: var(--cd-on-ink); }\n' +
      'html[data-cdtheme="dark"] .cd-paper-island .text-white { color: #ffffff; }\n';
    document.head.appendChild(el);
    applyTheme();
  })();

  const ICONS = {
    lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    smartphone:'<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
    trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    building:'<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
    logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    chev:'<path d="m9 18 6-6-6-6"/>',
    calc:'<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>',
    shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    receipt:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
    dash:'<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    coins:'<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    scroll:'<path d="M5 3h11l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    ledgerbook:'<g transform="translate(-3 -3) scale(1.25)" stroke-width="1.6"><path d="M12 5.5 C10.2 4.2 7.5 4 4.5 4.8 V18.6 C7.5 17.8 10.2 18 12 19.2 C13.8 18 16.5 17.8 19.5 18.6 V4.8 C16.5 4 13.8 4.2 12 5.5 Z" stroke="#17140F"/><path d="M12 5.5 V19.2" stroke="#17140F"/><path d="M7.5 9 H9.5 M14.5 9 H16.5 M7.5 12.5 H9.5 M14.5 12.5 H16.5" stroke="#17140F"/><path d="M16 4.4 V8.6 L17.4 7.5 L18.8 8.6 V4.6" stroke="#1D6B45"/></g>',
    gear:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    id:'<rect width="18" height="14" x="3" y="5" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M15 11h3M14 15h4M6 15h6"/>',
    printer:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
    upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    del:'<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z"/><line x1="18" x2="12" y1="9" y2="15"/><line x1="12" x2="18" y1="9" y2="15"/>',
    globe:'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
    clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    bars:'<line x1="4" x2="4" y1="20" y2="10"/><line x1="10" x2="10" y1="20" y2="4"/><line x1="16" x2="16" y1="20" y2="13"/><line x1="2" x2="22" y1="20" y2="20"/>',
    rateboard:'<g transform="translate(-2.16 -2.16) scale(1.18)" stroke-width="1.7"><rect x="3" y="3.5" width="18" height="13" rx="1.5" stroke="#17140F"/><path d="M9 20.5 L10.8 16.5 M15 20.5 L13.2 16.5" stroke="#17140F"/><path d="M6.5 13 V10.5 M10.2 13 V11.2 M13.8 13 V10" stroke="#17140F"/><path d="M6.5 8.5 L10.2 7 L13.8 8 L17.5 5.8" stroke="#1D6B45"/></g>',
    minus:'<path d="M5 12h14"/>',
    grip:'<line x1="4" x2="20" y1="8" y2="8"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="16" y2="16"/>',
    grid4:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    calendar:'<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18M8 2v4M16 2v4"/>',
    mail:'<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    cake:'<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3M12 8v3M17 8v3M7 4h.01M12 4h.01M17 4h.01"/>',
    mappin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    briefcase:'<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    camera:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    pencil:'<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    pie:'<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    arrowleft:'<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    sparkle:'<path d="M12 3l1.7 5.1a3 3 0 0 0 1.9 1.9L21 12l-5.4 1.7a3 3 0 0 0-1.9 1.9L12 21l-1.7-5.4a3 3 0 0 0-1.9-1.9L3 12l5.4-1.7a3 3 0 0 0 1.9-1.9z"/><path d="M19 4.5v3M20.5 6h-3"/>',
    percent:'<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    bag:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    send:'<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    transferarrows:'<g transform="translate(-3 -3) scale(1.25)" stroke-width="1.6"><path d="M4.5 8 H19.5 M16 4.5 L19.5 8 L16 11.5" stroke="#17140F"/><path d="M19.5 16 H4.5 M8 12.5 L4.5 16 L8 19.5" stroke="#1D6B45"/></g>',
    cheque:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="3.5" y="6" width="17" height="12.5" rx="1.5" stroke="#17140F"/><path d="M7 10 H14 M16.5 10 H17.5" stroke="#17140F"/><path d="M6.8 15.4 C7.8 13.2 9.6 13.4 10.1 15 C10.6 16.6 12.2 16.4 13.2 14.6" stroke="#1D6B45"/></g>',
    clientskyc:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><circle cx="9" cy="7.8" r="3.1" stroke="#17140F"/><path d="M3.5 19 C3.5 15.4 5.9 13.4 9 13.4 C12.1 13.4 14.5 15.4 14.5 19" stroke="#17140F"/><circle cx="16.8" cy="8.8" r="2.4" stroke="#1D6B45"/><path d="M15.6 13.2 C18.4 13 20.5 14.8 20.5 18" stroke="#1D6B45"/></g>',
    complianceshield:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><path d="M12 3.5 L19.5 6.2 V11.5 C19.5 16.3 16.3 19.5 12 20.7 C7.7 19.5 4.5 16.3 4.5 11.5 V6.2 Z" stroke="#17140F"/><path d="M8.3 11.9 L11 14.6 L15.7 9.4" stroke="#1D6B45"/></g>',
    reportsdoc:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="5.5" y="3.5" width="13" height="17" rx="1.5" stroke="#17140F"/><path d="M8.5 7.5 H15.5 M8.5 10.5 H13" stroke="#17140F"/><path d="M8.8 17 V15 M15.2 17 V15.8" stroke="#17140F"/><path d="M12 17 V13.2" stroke="#1D6B45"/></g>',
    pricingpercent:'<g transform="translate(-3 -3) scale(1.25)" stroke-width="1.6"><path d="M5 19 L19 5" stroke="#1D6B45"/><circle cx="7.2" cy="7.2" r="2.7" stroke="#17140F"/><circle cx="16.8" cy="16.8" r="2.7" stroke="#17140F"/></g>',
    dashboardgrid:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="4" y="4" width="7" height="7" rx="1" stroke="#17140F"/><rect x="13" y="4" width="7" height="7" rx="1" stroke="#17140F"/><rect x="4" y="13" width="7" height="7" rx="1" stroke="#17140F"/><rect x="13" y="13" width="7" height="7" rx="1" stroke="#1D6B45"/></g>',
    aispark:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><path d="M12 4 C12.5 8 16 11.5 20 12 C16 12.5 12.5 16 12 20 C11.5 16 8 12.5 4 12 C8 11.5 11.5 8 12 4 Z" stroke="#17140F"/></g>',
    tilldrawer:'<g transform="translate(-2.16 -2.16) scale(1.18)" stroke-width="1.7"><rect x="3.5" y="10" width="17" height="9.5" rx="1.5" stroke="#17140F"/><path d="M5.5 10 V7.5 A1.5 1.5 0 0 1 7 6 H15" stroke="#17140F"/><path d="M9.5 14.5 H14.5" stroke="#17140F"/><circle cx="18" cy="5" r="2.8" stroke="#1D6B45"/><path d="M18 3.8 V6.2" stroke="#1D6B45"/></g>',
    vaultsafe:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke="#17140F"/><circle cx="12" cy="12" r="4.6" stroke="#17140F"/><path d="M12 7.4 V5.8 M12 16.6 V18.2 M7.4 12 H5.8 M16.6 12 H18.2" stroke="#17140F"/><path d="M12 12 L14.8 9.8" stroke="#1D6B45"/><circle cx="12" cy="12" r="0.9" stroke="#1D6B45"/></g>',
    branchnet:'<g transform="translate(-1.2 -1.2) scale(1.1)" stroke-width="1.82"><circle cx="12" cy="5.9" r="2.6" stroke="#1D6B45"/><path d="M12 8.5 V13.5 M5.5 13.5 H18.5 M5.5 13.5 V15.3 M18.5 13.5 V15.3" stroke="#17140F"/><circle cx="5.5" cy="17.9" r="2.6" stroke="#17140F"/><circle cx="18.5" cy="17.9" r="2.6" stroke="#17140F"/></g>',
    audittrail:'<g transform="translate(-3 -3) scale(1.25)" stroke-width="1.6"><path d="M4.5 4.8 V8.5 H8.2" stroke="#17140F"/><path d="M5.2 8.5 A7.5 7.5 0 1 1 4.5 12.5" stroke="#17140F"/><path d="M12 8.6 V12 L14.7 13.5" stroke="#1D6B45"/></g>',
    calcdevice:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="6" y="3.5" width="12" height="17" rx="1.5" stroke="#17140F"/><path d="M8.7 6.5 H15.3 V9.2 H8.7 Z" stroke="#17140F"/><path d="M9.2 12.6 H9.22 M12 12.6 H12.02 M14.8 12.6 H14.82 M9.2 15.4 H9.22 M12 15.4 H12.02 M14.8 15.4 H14.82 M9.2 18.2 H9.22 M12 18.2 H12.02" stroke="#17140F"/><path d="M14 18.2 H15.6" stroke="#1D6B45"/></g>',
    calcmono:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="6" y="3.5" width="12" height="17" rx="1.5"/><path d="M8.7 6.5 H15.3 V9.2 H8.7 Z"/><path d="M9.2 12.6 H9.22 M12 12.6 H12.02 M14.8 12.6 H14.82 M9.2 15.4 H9.22 M12 15.4 H12.02 M14.8 15.4 H14.82 M9.2 18.2 H9.22 M12 18.2 H12.02"/><path d="M14 18.2 H15.6"/></g>',
    loancentre:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="#17140F"/><path d="M8 3.5 V6.5 M16 3.5 V6.5 M4 9.5 H20" stroke="#17140F"/><circle cx="12" cy="14.7" r="2.9" stroke="#1D6B45"/><path d="M12 13.3 V16.1" stroke="#1D6B45"/></g>',
    taggedbookmark:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><path d="M7 3.5 H17 V20.5 L12 16.9 L7 20.5 Z" stroke="#17140F"/><circle cx="12" cy="9.3" r="1.7" stroke="#1D6B45"/></g>',
    gearsettings:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" stroke="#17140F"/><circle cx="12" cy="12" r="3" stroke="#1D6B45"/>',
    storefront:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><path d="M4 8.2 V6.8 L5.8 4 H18.2 L20 6.8 V8.2 A2 2 0 0 1 16 8.2 A2 2 0 0 1 12 8.2 A2 2 0 0 1 8 8.2 A2 2 0 0 1 4 8.2 Z" stroke="#17140F"/><path d="M5 11 V20 H19 V11" stroke="#17140F"/><path d="M7.5 14.5 H10.5" stroke="#17140F"/><path d="M13.5 20 V14.5 H16.5 V20" stroke="#1D6B45"/></g>',
    power:'<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    check:'<polyline points="20 6 9 17 4 12"/>',
    checkcircle:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    filetext:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    userplus:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    ban:'<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    arrowdown:'<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    arrowup:'<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    trendup:'<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    trenddown:'<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    wallet:'<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/><path d="M16 13h.01"/>',
    card:'<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
    star:'<path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"/>',
    activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    arrowright:'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    swap:'<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
    info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    note:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    bookmark:'<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    tag:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.5"/>'
  };
  function Ic({ n, s = 16, c = 'currentColor' }) {
    return React.createElement('svg', {
      width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: c,
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { flexShrink: 0 }, dangerouslySetInnerHTML: { __html: ICONS[n] || '' }
    });
  }

  /* ---- domain constants ---- */
  const TYPES = ['Currency Exchange', 'Remittance — Send', 'Remittance — Receive', 'Cheque Cashing', 'Money Order', 'Bill Payment'];
  const CCY = ['CAD', 'USD', 'EUR', 'GBP', 'INR', 'PHP', 'CNY', 'MXN', 'AED'];
  const THRESHOLD = 10000, TODAY = '2026-06-18';
  const STAFF = [{ name: 'J. Masri', role: 'Owner' }, { name: 'R. Haddad', role: 'Manager' }, { name: 'A. Singh', role: 'Senior teller' }, { name: 'M. Costa', role: 'Cashier' }, { name: 'S. Iqbal', role: 'Trainee' }];
  /* capability preset per role. Owner is implicitly all-access. These mirror the
     one-click presets in Settings → Permissions; switching account applies the
     matching preset to the shared Teller config so each role can be previewed
     live. Anyone who isn't the Owner is a "teller" for scoping purposes. */
  const ROLE_CAPS = {
    'Owner':         { canDelete: true,  canExport: true,  canViewReports: true,  canEditKYC: true,  canSettings: true,  canCloseDay: true },
    'Manager':       { canDelete: true,  canExport: true,  canViewReports: true,  canEditKYC: true,  canSettings: true,  canCloseDay: true },
    'Senior teller': { canDelete: true,  canExport: true,  canViewReports: true,  canEditKYC: true,  canSettings: false, canCloseDay: true },
    'Cashier':       { canDelete: false, canExport: false, canViewReports: false, canEditKYC: true,  canSettings: false, canCloseDay: false },
    'Trainee':       { canDelete: false, canExport: false, canViewReports: false, canEditKYC: false, canSettings: false, canCloseDay: false },
  };

  /* ---- rate bridge: prefer the live engine, fall back to a local table ---- */
  const PER_CAD = { CAD: 1, USD: 0.731, EUR: 0.676, GBP: 0.581, INR: 62.4, PHP: 41.2, CNY: 5.28, MXN: 13.1, AED: 2.68 };
  function crossRate(inC, outC) {
    if (typeof convRate === 'function' && typeof BY !== 'undefined' && BY[inC] && BY[outC]) {
      return +convRate(inC, outC).toFixed(4);
    }
    return +(PER_CAD[outC] / PER_CAD[inC]).toFixed(4);
  }
  function perCadLive(code) {
    if (typeof BY !== 'undefined' && BY[code]) return +BY[code].perCad.toFixed(code === 'CAD' ? 0 : 4);
    return PER_CAD[code];
  }

  /* ---- rate book bridge (Rate Board ↔ Ledger) ----
     A "book" is a { CODE: perCad } map where perCad = units of that currency
     per 1 CAD (matching the engine's BY[code].perCad). publishedBook() reads the
     staff-published board from localStorage; applyBook() pushes a book into the
     live engine so crossRate()/perCadLive() immediately reflect it; bookSig()
     gives a cheap change-key. */
  function publishedBook() {
    const book = {};
    const list = (typeof CUR !== 'undefined' ? CUR : []);
    list.forEach(c => { book[c.code] = c.perCadDefault != null ? c.perCadDefault : c.perCad; });
    if (!list.length) Object.keys(PER_CAD).forEach(k => { book[k] = PER_CAD[k]; });
    try {
      const cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || 'null');
      if (cfg && cfg.rows) Object.keys(cfg.rows).forEach(code => {
        const r = cfg.rows[code];
        if (r && typeof r.mid === 'number' && r.mid > 0 && book[code] != null) book[code] = 1 / r.mid;
      });
    } catch (e) {}
    return book;
  }
  function applyBook(book) {
    if (!book) return;
    Object.keys(book).forEach(code => {
      if (typeof BY !== 'undefined' && BY[code]) BY[code].perCad = book[code];
      if (PER_CAD[code] != null) PER_CAD[code] = book[code];
    });
  }
  function bookSig(book) {
    if (!book) return '';
    return Object.keys(book).sort().map(k => k + ':' + (+book[k]).toFixed(6)).join('|');
  }

  const fmt = (n, c) => isNaN(n) || n === '' ? '' : new Intl.NumberFormat('en-CA', { style: 'currency', currency: c || 'CAD', maximumFractionDigits: 2 }).format(Number(n));
  const num = (n) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 2 }).format(Number(n) || 0);
  const dDiff = (a, b) => (new Date(b) - new Date(a)) / 86400000;

  /* ============================================================
     SINGLE SOURCE OF TRUTH — physical cash position
     position(c, rows, baseline, receipts) is a PURE function of its
     arguments (no closure over module state) so every reader — the
     Till's "expected" and the Vault's "position" — computes the
     identical number and they physically cannot disagree. Stock is
     DERIVED from posted records, never stored:

        units(c) = baseline(c) + Σ receipts(c) + ledgerIn(c) − ledgerOut(c)

     Voids leave the books. Cost basis is the weighted average of every
     REAL inflow — opening baseline, wholesale receipts, AND customer
     sell-ins (a walk-in selling us USD is a real acquisition at the CAD
     we paid). Selling reduces quantity, never the per-unit basis; basis
     clamps to 0 if a position is run flat or short. Wholesale receipts
     live in their own treasury store (not the customer ledger) so a BMO
     banknote purchase never trips a KYC/AML flag or inflates FX margin —
     but they feed THIS function, so the till counts against them too. */
  function defaultBaseline() {
    return {
      anchor: '2026-06-01',
      units: { CAD: 238500, USD: 34200, EUR: 11600, GBP: 6400, INR: 4180000, PHP: 1760000, CNY: 96000, MXN: 372000, AED: 61500 },
      cost: { CAD: 1, USD: 1.351, EUR: 1.502, GBP: 1.690, INR: 0.01588, PHP: 0.02455, CNY: 0.1902, MXN: 0.07410, AED: 0.3731 }
    };
  }
  function defaultReceipts() {
    return [
      { id: 1, ccy: 'USD', units: 50000, costCad: 68200, unitCost: 1.364, supplier: 'Bank of Montreal — Wholesale Notes', ref: 'WO-260605-USD', date: '2026-06-05', by: 'J. Masri', status: 'received' },
      { id: 2, ccy: 'EUR', units: 20000, costCad: 30100, unitCost: 1.505, supplier: 'Continental Cash Services', ref: 'WO-260610-EUR', date: '2026-06-10', by: 'J. Masri', status: 'received' }
    ];
  }
  const _cadOf = (amt, c) => c === 'CAD' ? (+amt || 0) : (+amt || 0) * (crossRate(c, 'CAD') || 0);
  // chronological inflow/outflow events for one currency (void-aware), so the
  // cost-basis walk and the short-cross clamp are correct, not just for seeds
  function _holdEvents(c, rows, receipts) {
    const evs = [];
    (rows || []).forEach(r => {
      if (r.status === 'void') return;
      if (r.inCcy === c) { const u = +r.inAmt || 0; const cad = _cadOf(r.outAmt, r.outCcy); evs.push({ k: (r.date || '') + ' ' + (r.time || '00:00'), dir: 'in', u, uc: u ? cad / u : 0 }); }
      if (r.outCcy === c) { evs.push({ k: (r.date || '') + ' ' + (r.time || '00:00'), dir: 'out', u: +r.outAmt || 0 }); }
    });
    (receipts || []).forEach(o => { if (o.ccy === c && o.status === 'received') { const u = +o.units || 0; evs.push({ k: (o.date || '') + ' 12:00', dir: 'in', u, uc: u ? (+o.costCad || 0) / u : 0 }); } });
    evs.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
    return evs;
  }
  function position(c, rows, baseline, receipts) {
    const b = baseline || defaultBaseline();
    let qty = (b.units && b.units[c]) || 0;
    let avg = (b.cost && b.cost[c] != null) ? b.cost[c] : 0;
    _holdEvents(c, rows, receipts).forEach(e => {
      if (e.dir === 'in') { const q2 = qty + e.u; avg = q2 > 0 ? (qty * avg + e.u * e.uc) / q2 : e.uc; qty = q2; }
      else { qty -= e.u; if (qty <= 0) { qty = Math.max(0, qty); if (qty === 0) avg = 0; } }
    });
    if (c === 'CAD') avg = 1;
    return { units: qty, cost: +(+avg).toFixed(6) };
  }
  const holdings = (c, rows, baseline, receipts) => position(c, rows, baseline, receipts).units;

  /* ============================================================
     TWO-SIDED PRICING — the defining act of the desk, one pure function
     A real desk publishes a BUY rate and a SELL rate per currency; the
     gap between them (the spread) is the margin. priceDeal() is the single
     source of truth both the Ledger (quoting) and Reports (earnings) call,
     so the spread shown at the counter is the exact spread booked — never
     a back-estimate. The desk RECEIVES the pay-in currency (buys it, under
     mid) and GIVES the pay-out currency (sells it, over mid); a foreign→
     foreign cross pays spread on both legs.

        unit CAD (mid)   = crossRate(code,'CAD')           // CAD per 1 unit
        we BUY  1 unit   = mid · (1 − spread)              // what we pay out
        we SELL 1 unit   = mid · (1 + spread)              // what we charge
        rate(out/in)     = inUnitCad(buy) ÷ outUnitCad(sell)
        margin (CAD)     = mid value in − mid value out    // = spread captured

     Spread is per-currency (settings.spreads[code], %) falling back to the
     global default; rounding of the customer pay-out is configurable. */
  const DEFAULT_SPREAD = 0.015;
  function spreadOf(code, settings) {
    if (code === 'CAD') return 0;
    const sp = settings && settings.spreads;
    if (sp && sp[code] != null && sp[code] !== '' && !isNaN(sp[code])) return Math.max(0, +sp[code]) / 100;
    if (settings && settings.defaultSpread != null && !isNaN(settings.defaultSpread)) return Math.max(0, +settings.defaultSpread) / 100;
    return DEFAULT_SPREAD;
  }
  const unitCadMid = (code) => code === 'CAD' ? 1 : (crossRate(code, 'CAD') || 0);
  const buyUnitCad = (code, s) => code === 'CAD' ? 1 : unitCadMid(code) * (1 - spreadOf(code, s));   // we pay this to acquire 1 unit
  const sellUnitCad = (code, s) => code === 'CAD' ? 1 : unitCadMid(code) * (1 + spreadOf(code, s));  // we charge this to release 1 unit

  // round a customer pay-out per the configured rule. mode: nearest|down|up
  // ('down' favours the desk, 'up' favours the customer); inc is the increment.
  function roundPayout(amt, settings) {
    const a = +amt || 0;
    const inc = settings && settings.payoutRoundTo != null ? +settings.payoutRoundTo : 0.01;
    const mode = (settings && settings.payoutRoundMode) || 'nearest';
    if (!inc || inc <= 0) return +a.toFixed(2);
    const q = a / inc;
    const r = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
    return +(r * inc).toFixed(2);
  }

  /* the one pricing call. side is informational: 'sell' (we give foreign for
     CAD), 'buy' (we take foreign for CAD), or 'cross' (foreign↔foreign).
     lockedRate, when passed, overrides the live two-sided rate (a rate lock);
     margin is still measured against the *current* mid so a held quote that
     moves with the market still books its true captured spread. */
  function priceDeal({ inCcy, outCcy, inAmt, settings, lockedRate, overrideRate }) {
    const amt = +inAmt || 0;
    const inEach = buyUnitCad(inCcy, settings);     // CAD value to us of each in-unit
    const outEach = sellUnitCad(outCcy, settings);  // CAD we charge per out-unit
    const deskRate = outEach ? inEach / outEach : 0;            // outCcy per 1 inCcy
    const midRate = crossRate(inCcy, outCcy) || 0;
    const rate = (overrideRate != null && overrideRate !== '' && !isNaN(overrideRate)) ? +overrideRate
               : (lockedRate != null ? +lockedRate : deskRate);
    const outAmtRaw = amt * rate;
    const outAmt = roundPayout(outAmtRaw, settings);
    // margin in CAD = mid value of what we took in − mid value of what we gave out
    const midCadIn = amt * unitCadMid(inCcy);
    const midCadOut = outAmt * unitCadMid(outCcy);
    const marginCad = +(midCadIn - midCadOut).toFixed(2);
    const side = inCcy === 'CAD' ? 'sell' : outCcy === 'CAD' ? 'buy' : 'cross';
    const spreadPct = midCadIn ? (marginCad / midCadIn) * 100 : 0;
    return { rate: +(+rate).toFixed(6), deskRate: +deskRate.toFixed(6), midRate: +midRate.toFixed(6), outAmt, outAmtRaw, marginCad, spreadPct, side, midCadIn };
  }
  // exact booked margin for a posted row: prefer the stored figure, else the
  // legacy live-mid estimate (so historical rows still show a spread)
  function dealMargin(r) {
    if (r && r.spreadCad != null && !isNaN(r.spreadCad)) return Math.max(0, +r.spreadCad);
    const mid = (+r.inAmt || 0) * crossRate(r.inCcy, r.outCcy);
    const d = mid - (+r.outAmt || 0);
    return d > 0 ? d / (perCadLive(r.outCcy) || 1) : 0;
  }

  /* human-readable, sortable reference: LT-YYMMDD-NNN */
  const mkRef = (date, seq) => 'LT-' + String(date).slice(2).replace(/-/g, '') + '-' + String(seq).padStart(3, '0');
  const nowTime = () => new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });

  /* factory for a fresh, fully-formed transaction record */
  function newTx(over = {}) {
    return Object.assign({
      id: Date.now() + Math.floor(Math.random() * 1000),
      ref: '', date: TODAY, time: nowTime(),
      customer: '', beneficiary: '', type: 'Currency Exchange',
      inCcy: 'CAD', inAmt: '', rate: crossRate('CAD', 'USD'), outCcy: 'USD', outAmt: '', fee: '',
      midRate: null, spreadCad: null, side: null,   /* two-sided pricing: booked margin vs mid */
      quoteRef: null, lockedUntil: null,            /* rate-lock provenance, if quoted */
      teller: '', notes: '',
      status: 'posted',          /* posted | void — never deleted */
      thread: [],                /* append-only note log [{ts,user,text}] */
      filed: false, filedInfo: null,   /* LCTR report filing */
      ackStr: false, ackStrInfo: null, /* structuring acknowledgement */
      marginPct: null, profitCad: null, marginOverride: null, /* margin-floor guardrail */
      capture: null,                   /* point-of-sale FINTRAC capture (purpose/source/3rd-party) */
      tagged: false, tagInfo: null,    /* teller/owner follow-up tag */
      voidReason: '', voidBy: '', voidAt: '',
      createdBy: '', createdAt: ''
    }, over);
  }

  /* ---- one-time roster rename (v2): devices that persisted stores under the
     old demo client names get them rewritten in place, so cheques / transfers /
     beneficiaries match the new seed roster without wiping any user work.
     Every search string contains a space, dot or @ so base64 blobs can't match. ---- */
  try {
    if (!localStorage.getItem('cdos_roster_v2')) {
      const REN = [["d.okafor@email.com","jakob.miller@email.com"],["lucia.ferraro@email.com","rachel.carter@email.com"],["m.reyes@email.com","tyler.bennett@email.com"],["elena.cruz@email.com","megan.foster@email.com"],["sofia.lim@email.com","ashley.turner@email.com"],["hassan.ali@email.com","kevin.doyle@email.com"],["mei.chen@email.com","emily.park@email.com"],["o.adeyemi@email.com","brandon.cole@email.com"],["yuki.tanaka@email.com","lauren.bishop@email.com"],["c.mendez@email.com","chris.delaney@email.com"],["fatima.khan@email.com","nicole.hayes@email.com"],["ravi.patel@email.com","jordan.blake@email.com"],["grace.owusu@email.com","sarah.whitman@email.com"],["tomas.novak@email.com","marcus.reed@email.com"],["Daniel Okafor","Jakob Miller"],["Lucia Ferraro","Rachel Carter"],["Aran Voss","Brooke Lawson"],["Marco Reyes","Tyler Bennett"],["Elena Cruz","Megan Foster"],["Sofia Lim","Ashley Turner"],["Hassan Ali","Kevin Doyle"],["Mei Chen","Emily Park"],["Olawale Adeyemi","Brandon Cole"],["Yuki Tanaka","Lauren Bishop"],["Carlos Mendez","Chris Delaney"],["Fatima Khan","Nicole Hayes"],["Ravi Patel","Jordan Blake"],["Grace Owusu","Sarah Whitman"],["Tomas Novak","Marcus Reed"],["Maria Ferraro","Maria Carter"],["M. Ferraro","M. Carter"],["Rohan Okafor","Rohan Miller"],["A. Ali · Dubai","A. Doyle · Dubai"],["L. Chen · Shanghai","L. Park · Shanghai"],["S. Patel · Mumbai","S. Blake · Mumbai"],["R. Mendez · Guadalajara","R. Delaney · Guadalajara"],["A. Khan · Dubai","A. Hayes · Dubai"],["Okafor","Miller"],["Ferraro","Carter"],["Adeyemi","Cole"],["Tanaka","Bishop"],["Owusu","Whitman"],["Novak","Reed"]];
      Object.keys(localStorage).forEach((k) => {
        if (k.indexOf('cdos_') !== 0 && k.indexOf('yorkfx_') !== 0) return;
        const v = localStorage.getItem(k); if (!v) return;
        let nv = v; REN.forEach((p) => { nv = nv.split(p[0]).join(p[1]); });
        if (nv !== v) localStorage.setItem(k, nv);
      });
      localStorage.setItem('cdos_roster_v2', '1');
    }
  } catch (e) {}

  const seedRows = () => [
    { id: 1, ref: 'LT-260618-001', date: '2026-06-18', time: '09:41', customer: 'Jakob Miller', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 2400, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(2400*crossRate('CAD','USD')).toFixed(2), fee: 18, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-18 09:41' },
    { id: 2, ref: 'LT-260618-002', date: '2026-06-18', time: '10:12', customer: 'Rachel Carter', beneficiary: 'M. Carter · Cebu', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 600, rate: crossRate('CAD','PHP'), outCcy: 'PHP', outAmt: +(600*crossRate('CAD','PHP')).toFixed(2), fee: 9.99, teller: 'M. Costa', notes: 'Cebu pickup', status: 'posted', thread: [{ ts: '2026-06-18 10:12', user: 'M. Costa', text: 'Beneficiary: M. Carter, Cebu branch pickup.' }], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-18 10:12' },
    { id: 3, ref: 'LT-260617-014', date: '2026-06-17', time: '15:28', customer: 'Northbridge Imports', type: 'Currency Exchange', inCcy: 'USD', inAmt: 14500, rate: crossRate('USD','CAD'), outCcy: 'CAD', outAmt: +(14500*crossRate('USD','CAD')).toFixed(2), fee: 120, teller: 'R. Haddad', notes: 'Invoice settlement', status: 'posted', thread: [{ ts: '2026-06-17 15:30', user: 'R. Haddad', text: 'Large Cash Transaction Report filed with FINTRAC — invoice settlement, source of funds verified.' }], filed: true, filedInfo: { ref: 'LCTR-0461', by: 'R. Haddad', at: '2026-06-17 15:30' }, ackStr: false, ackStrInfo: null, tagged: true, tagInfo: { by: 'J. Masri', at: '2026-06-17 16:02', note: 'Owner review — recurring corporate client' }, createdBy: 'R. Haddad', createdAt: '2026-06-17 15:28' },
    { id: 4, ref: 'LT-260617-009', date: '2026-06-17', time: '11:05', customer: 'Jakob Miller', type: 'Cheque Cashing', inCcy: 'CAD', inAmt: 1850, rate: 1, outCcy: 'CAD', outAmt: 1813, fee: 37, teller: 'A. Singh', notes: 'Payroll cheque', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-17 11:05' },
    { id: 5, ref: 'LT-260616-021', date: '2026-06-16', time: '16:44', customer: 'Brooke Lawson', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 9400, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(9400*crossRate('CAD','USD')).toFixed(2), fee: 70, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-16 16:44' },
    { id: 6, ref: 'LT-260618-006', date: '2026-06-18', time: '13:20', customer: 'Brooke Lawson', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 9200, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(9200*crossRate('CAD','USD')).toFixed(2), fee: 68, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, tagged: true, tagInfo: { by: 'A. Singh', at: '2026-06-18 13:25', note: 'Watching — two near-$10k deals this week' }, createdBy: 'M. Costa', createdAt: '2026-06-18 13:20' },
    { id: 7, ref: 'LT-260616-008', date: '2026-06-16', time: '10:33', customer: 'Rachel Carter', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 950, rate: crossRate('CAD','EUR'), outCcy: 'EUR', outAmt: +(950*crossRate('CAD','EUR')).toFixed(2), fee: 12, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-16 10:33' },
    /* ---- 24-hour aggregation demos (all 2026-06-18) ----
       Beneficiary axis: three different conductors each send sub-$10k to ONE
       beneficiary — no single person is reportable, but the beneficiary total
       is. Only the by-beneficiary aggregation catches it. */
    { id: 8, ref: 'LT-260618-008', date: '2026-06-18', time: '11:14', customer: 'Tyler Bennett', beneficiary: 'M. Carter · Cebu', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 4200, rate: crossRate('CAD','PHP'), outCcy: 'PHP', outAmt: +(4200*crossRate('CAD','PHP')).toFixed(2), fee: 19.99, teller: 'A. Singh', notes: 'Cebu pickup', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-18 11:14' },
    { id: 9, ref: 'LT-260618-009', date: '2026-06-18', time: '12:48', customer: 'Megan Foster', beneficiary: 'M. Carter · Cebu', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 4300, rate: crossRate('CAD','PHP'), outCcy: 'PHP', outAmt: +(4300*crossRate('CAD','PHP')).toFixed(2), fee: 19.99, teller: 'M. Costa', notes: 'Cebu pickup', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-18 12:48' },
    { id: 10, ref: 'LT-260618-010', date: '2026-06-18', time: '15:02', customer: 'Ashley Turner', beneficiary: 'M. Carter · Cebu', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 4100, rate: crossRate('CAD','PHP'), outCcy: 'PHP', outAmt: +(4100*crossRate('CAD','PHP')).toFixed(2), fee: 19.99, teller: 'A. Singh', notes: 'Cebu pickup', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-18 15:02' },
    /* Conductor axis: one person splits a buy into two sub-$10k cash-ins inside the window. */
    { id: 11, ref: 'LT-260618-011', date: '2026-06-18', time: '10:36', customer: 'Brooke Lawson', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 4300, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(4300*crossRate('CAD','USD')).toFixed(2), fee: 32, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-18 10:36' },
    /* ---- a full week of ordinary back-office flow (2026-06-12 → 06-18) ---- */
    { id: 12, ref: 'LT-260612-003', date: '2026-06-12', time: '09:55', customer: 'Jakob Miller', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 1200, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(1200*crossRate('CAD','USD')).toFixed(2), fee: 14, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-12 09:55' },
    { id: 13, ref: 'LT-260612-005', date: '2026-06-12', time: '11:20', customer: 'Emily Park', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 3200, rate: crossRate('CAD','CNY'), outCcy: 'CNY', outAmt: +(3200*crossRate('CAD','CNY')).toFixed(2), fee: 26, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-12 11:20' },
    { id: 14, ref: 'LT-260612-007', date: '2026-06-12', time: '13:40', customer: 'Kevin Doyle', beneficiary: 'A. Doyle · Dubai', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 850, rate: crossRate('CAD','AED'), outCcy: 'AED', outAmt: +(850*crossRate('CAD','AED')).toFixed(2), fee: 12.99, teller: 'S. Iqbal', notes: 'Dubai payout', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-12 13:40' },
    { id: 15, ref: 'LT-260612-009', date: '2026-06-12', time: '15:10', customer: 'Sarah Whitman', type: 'Cheque Cashing', inCcy: 'CAD', inAmt: 920, rate: 1, outCcy: 'CAD', outAmt: 892, fee: 28, teller: 'A. Singh', notes: 'Payroll cheque', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-12 15:10' },
    { id: 16, ref: 'LT-260612-012', date: '2026-06-12', time: '16:30', customer: 'Golden Crescent Travel', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 6800, rate: crossRate('CAD','EUR'), outCcy: 'EUR', outAmt: +(6800*crossRate('CAD','EUR')).toFixed(2), fee: 54, teller: 'R. Haddad', notes: 'Group travel float', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'R. Haddad', createdAt: '2026-06-12 16:30' },
    { id: 17, ref: 'LT-260613-002', date: '2026-06-13', time: '10:05', customer: 'Jordan Blake', beneficiary: 'S. Blake · Mumbai', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 1500, rate: crossRate('CAD','INR'), outCcy: 'INR', outAmt: +(1500*crossRate('CAD','INR')).toFixed(2), fee: 14.99, teller: 'M. Costa', notes: 'Mumbai deposit', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-13 10:05' },
    { id: 18, ref: 'LT-260613-004', date: '2026-06-13', time: '12:15', customer: 'Lauren Bishop', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 2100, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(2100*crossRate('CAD','USD')).toFixed(2), fee: 19, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-13 12:15' },
    { id: 19, ref: 'LT-260613-006', date: '2026-06-13', time: '14:50', customer: 'Chris Delaney', beneficiary: 'R. Delaney · Guadalajara', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 1100, rate: crossRate('CAD','MXN'), outCcy: 'MXN', outAmt: +(1100*crossRate('CAD','MXN')).toFixed(2), fee: 12.99, teller: 'S. Iqbal', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-13 14:50' },
    { id: 20, ref: 'LT-260613-008', date: '2026-06-13', time: '15:35', customer: 'Nicole Hayes', type: 'Bill Payment', inCcy: 'CAD', inAmt: 340, rate: 1, outCcy: 'CAD', outAmt: 340, fee: 4.99, teller: 'M. Costa', notes: 'Utility bill', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-13 15:35' },
    { id: 21, ref: 'LT-260614-002', date: '2026-06-14', time: '11:40', customer: 'Brandon Cole', type: 'Money Order', inCcy: 'CAD', inAmt: 600, rate: 1, outCcy: 'CAD', outAmt: 600, fee: 6.99, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-14 11:40' },
    { id: 22, ref: 'LT-260614-004', date: '2026-06-14', time: '13:05', customer: 'Rachel Carter', beneficiary: 'M. Carter · Cebu', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 700, rate: crossRate('CAD','PHP'), outCcy: 'PHP', outAmt: +(700*crossRate('CAD','PHP')).toFixed(2), fee: 9.99, teller: 'M. Costa', notes: 'Cebu pickup', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-14 13:05' },
    { id: 23, ref: 'LT-260615-002', date: '2026-06-15', time: '09:30', customer: 'Marcus Reed', type: 'Currency Exchange', inCcy: 'EUR', inAmt: 1800, rate: crossRate('EUR','CAD'), outCcy: 'CAD', outAmt: +(1800*crossRate('EUR','CAD')).toFixed(2), fee: 22, teller: 'R. Haddad', notes: 'Tourist buy-back', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'R. Haddad', createdAt: '2026-06-15 09:30' },
    { id: 24, ref: 'LT-260615-004', date: '2026-06-15', time: '10:45', customer: 'Maple Leaf Logistics Inc.', type: 'Currency Exchange', inCcy: 'USD', inAmt: 8200, rate: crossRate('USD','CAD'), outCcy: 'CAD', outAmt: +(8200*crossRate('USD','CAD')).toFixed(2), fee: 78, teller: 'R. Haddad', notes: 'Carrier settlement', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'R. Haddad', createdAt: '2026-06-15 10:45' },
    { id: 25, ref: 'LT-260615-006', date: '2026-06-15', time: '12:00', customer: 'Emily Park', beneficiary: 'L. Park · Shanghai', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 2600, rate: crossRate('CAD','CNY'), outCcy: 'CNY', outAmt: +(2600*crossRate('CAD','CNY')).toFixed(2), fee: 18.99, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-15 12:00' },
    { id: 26, ref: 'LT-260615-009', date: '2026-06-15', time: '14:20', customer: 'Jakob Miller', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 500, rate: crossRate('CAD','GBP'), outCcy: 'GBP', outAmt: +(500*crossRate('CAD','GBP')).toFixed(2), fee: 8, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-15 14:20' },
    { id: 27, ref: 'LT-260615-012', date: '2026-06-15', time: '16:10', customer: 'Kevin Doyle', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 3400, rate: crossRate('CAD','AED'), outCcy: 'AED', outAmt: +(3400*crossRate('CAD','AED')).toFixed(2), fee: 28, teller: 'S. Iqbal', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-15 16:10' },
    { id: 28, ref: 'LT-260616-005', date: '2026-06-16', time: '09:50', customer: 'Sarah Whitman', type: 'Remittance — Receive', inCcy: 'USD', inAmt: 1200, rate: crossRate('USD','CAD'), outCcy: 'CAD', outAmt: +(1200*crossRate('USD','CAD')).toFixed(2), fee: 11, teller: 'M. Costa', notes: 'Inbound from US', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-16 09:50' },
    { id: 29, ref: 'LT-260616-011', date: '2026-06-16', time: '11:25', customer: 'Jordan Blake', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 1750, rate: crossRate('CAD','INR'), outCcy: 'INR', outAmt: +(1750*crossRate('CAD','INR')).toFixed(2), fee: 15, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-16 11:25' },
    { id: 30, ref: 'LT-260616-015', date: '2026-06-16', time: '13:15', customer: 'Chris Delaney', type: 'Cheque Cashing', inCcy: 'CAD', inAmt: 1320, rate: 1, outCcy: 'CAD', outAmt: 1287, fee: 33, teller: 'S. Iqbal', notes: 'Payroll cheque', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-16 13:15' },
    { id: 31, ref: 'LT-260616-018', date: '2026-06-16', time: '15:55', customer: 'Golden Crescent Travel', beneficiary: 'Hotel Andalus · Sevilla', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 5200, rate: crossRate('CAD','EUR'), outCcy: 'EUR', outAmt: +(5200*crossRate('CAD','EUR')).toFixed(2), fee: 44, teller: 'R. Haddad', notes: 'Hotel block deposit', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'R. Haddad', createdAt: '2026-06-16 15:55' },
    { id: 32, ref: 'LT-260617-003', date: '2026-06-17', time: '10:20', customer: 'Lauren Bishop', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 2800, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(2800*crossRate('CAD','USD')).toFixed(2), fee: 24, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-17 10:20' },
    { id: 33, ref: 'LT-260617-006', date: '2026-06-17', time: '12:40', customer: 'Nicole Hayes', beneficiary: 'A. Hayes · Dubai', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 980, rate: crossRate('CAD','AED'), outCcy: 'AED', outAmt: +(980*crossRate('CAD','AED')).toFixed(2), fee: 12.99, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-17 12:40' },
    { id: 34, ref: 'LT-260617-011', date: '2026-06-17', time: '14:30', customer: 'Brandon Cole', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 4100, rate: crossRate('CAD','USD'), outCcy: 'USD', outAmt: +(4100*crossRate('CAD','USD')).toFixed(2), fee: 33, teller: 'S. Iqbal', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-17 14:30' },
    { id: 35, ref: 'LT-260617-016', date: '2026-06-17', time: '16:15', customer: 'Northbridge Imports', type: 'Currency Exchange', inCcy: 'USD', inAmt: 6200, rate: crossRate('USD','CAD'), outCcy: 'CAD', outAmt: +(6200*crossRate('USD','CAD')).toFixed(2), fee: 58, teller: 'R. Haddad', notes: 'Invoice settlement', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'R. Haddad', createdAt: '2026-06-17 16:15' },
    { id: 36, ref: 'LT-260618-013', date: '2026-06-18', time: '09:20', customer: 'Marcus Reed', type: 'Money Order', inCcy: 'CAD', inAmt: 450, rate: 1, outCcy: 'CAD', outAmt: 450, fee: 5.99, teller: 'A. Singh', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'A. Singh', createdAt: '2026-06-18 09:20' },
    { id: 37, ref: 'LT-260618-015', date: '2026-06-18', time: '14:10', customer: 'Emily Park', type: 'Currency Exchange', inCcy: 'CAD', inAmt: 1900, rate: crossRate('CAD','CNY'), outCcy: 'CNY', outAmt: +(1900*crossRate('CAD','CNY')).toFixed(2), fee: 16, teller: 'M. Costa', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'M. Costa', createdAt: '2026-06-18 14:10' },
    { id: 38, ref: 'LT-260618-017', date: '2026-06-18', time: '16:25', customer: 'Chris Delaney', beneficiary: 'R. Delaney · Guadalajara', type: 'Remittance — Send', inCcy: 'CAD', inAmt: 1250, rate: crossRate('CAD','MXN'), outCcy: 'MXN', outAmt: +(1250*crossRate('CAD','MXN')).toFixed(2), fee: 12.99, teller: 'S. Iqbal', notes: '', status: 'posted', thread: [], filed: false, filedInfo: null, ackStr: false, ackStrInfo: null, createdBy: 'S. Iqbal', createdAt: '2026-06-18 16:25' }
  ];
  const seedClients = () => ({
    'Jakob Miller': { kind: 'individual', idType: "Driver's Licence", idNum: 'DL 8841-220', idExpiry: '2028-04-01', photo: null, email: 'jakob.miller@email.com', phone: '(416) 555-0142', dob: '1989-03-22', occupation: 'Electrician', address: '88 Lansdowne Ave', city: 'Toronto', province: 'ON', postal: 'M6K 2W2', risk: 'Standard' },
    'Rachel Carter': { kind: 'individual', idType: 'Passport', idNum: 'X4521889', idExpiry: '2027-11-12', photo: null, email: 'rachel.carter@email.com', phone: '(647) 555-0198', dob: '1994-07-09', occupation: 'Nurse', address: '12 Bloor St W', city: 'Toronto', province: 'ON', postal: 'M4W 1A8', risk: 'Standard', notes: 'Regular monthly remittance to family in Cebu.' },
    'Northbridge Imports': { kind: 'corporate', idType: 'Business Number', idNum: 'BN 77120', idExpiry: '2030-01-01', photo: null, email: 'accounts@northbridge.ca', phone: '(905) 555-0110', incorpDate: '2014-02-18', jurisdiction: 'Ontario, Canada', business: 'Import / export of industrial goods', contactName: 'Priya Nair', contactTitle: 'Controller', address: '4500 Dixie Rd', city: 'Mississauga', province: 'ON', postal: 'L4W 1V6', risk: 'Enhanced', notes: 'Recurring corporate FX — source of funds verified via invoices.' },
    'Brooke Lawson': { kind: 'individual', idType: '', idNum: '', idExpiry: '', photo: null, phone: '(416) 555-0077' },
    'Tyler Bennett': { kind: 'individual', idType: "Driver's Licence", idNum: 'DL 5521-907', idExpiry: '2029-06-01', photo: null, email: 'tyler.bennett@email.com', phone: '(416) 555-0211', dob: '1986-11-02', occupation: 'Warehouse supervisor', address: '210 Jane St', city: 'Toronto', province: 'ON', postal: 'M6S 3Z9', risk: 'Standard', notes: 'Sends to family in Cebu.' },
    'Megan Foster': { kind: 'individual', idType: 'Passport', idNum: 'P7783201', idExpiry: '2028-03-15', photo: null, email: 'megan.foster@email.com', phone: '(647) 555-0212', dob: '1991-05-19', occupation: 'Caregiver', address: '55 Dundas St E', city: 'Toronto', province: 'ON', postal: 'M5B 1C6', risk: 'Standard' },
    'Ashley Turner': { kind: 'individual', idType: 'PR Card', idNum: 'PR 99213', idExpiry: '2027-09-09', photo: null, email: 'ashley.turner@email.com', phone: '(437) 555-0213', dob: '1989-08-23', occupation: 'Accountant', address: '88 Sheppard Ave E', city: 'Toronto', province: 'ON', postal: 'M2N 6Z1', risk: 'Standard' },
    'Kevin Doyle': { kind: 'individual', idType: 'Passport', idNum: 'A1290734', idExpiry: '2030-01-20', photo: null, email: 'kevin.doyle@email.com', phone: '(416) 555-0244', dob: '1983-02-14', occupation: 'Contractor', address: '301 Markham Rd', city: 'Scarborough', province: 'ON', postal: 'M1J 3R4', risk: 'Standard', notes: 'Regular AED remittances to Dubai.' },
    'Emily Park': { kind: 'individual', idType: 'Passport', idNum: 'E55129003', idExpiry: '2029-12-01', photo: null, email: 'emily.park@email.com', phone: '(647) 555-0255', dob: '1990-07-07', occupation: 'Software developer', address: '120 Yonge St', city: 'Toronto', province: 'ON', postal: 'M5C 1T4', risk: 'Standard' },
    'Brandon Cole': { kind: 'individual', idType: "Driver's Licence", idNum: 'DL 7741-330', idExpiry: '2028-08-08', photo: null, email: 'brandon.cole@email.com', phone: '(416) 555-0266', dob: '1987-09-30', occupation: 'Registered nurse', address: '44 Eglinton Ave W', city: 'Toronto', province: 'ON', postal: 'M4R 1A1', risk: 'Standard' },
    'Lauren Bishop': { kind: 'individual', idType: 'Passport', idNum: 'TK4459021', idExpiry: '2031-04-04', photo: null, email: 'lauren.bishop@email.com', phone: '(437) 555-0277', dob: '1993-01-12', occupation: 'Graphic designer', address: '15 Queen St W', city: 'Toronto', province: 'ON', postal: 'M5H 2M9', risk: 'Standard' },
    'Chris Delaney': { kind: 'individual', idType: "Driver's Licence", idNum: 'DL 2231-118', idExpiry: '2026-07-01', photo: null, email: 'chris.delaney@email.com', phone: '(416) 555-0288', dob: '1985-03-08', occupation: 'Landscaper', address: '17 Weston Rd', city: 'Toronto', province: 'ON', postal: 'M6N 3P1', risk: 'Standard', notes: 'ID expires soon — re-verify on next visit.' },
    'Nicole Hayes': { kind: 'individual', idType: 'Passport', idNum: 'FK7781299', idExpiry: '2029-05-05', photo: null, email: 'nicole.hayes@email.com', phone: '(647) 555-0299', dob: '1992-10-21', occupation: 'Pharmacist', address: '70 Birchmount Rd', city: 'Scarborough', province: 'ON', postal: 'M1N 3J6', risk: 'Standard' },
    'Jordan Blake': { kind: 'individual', idType: "Driver's Licence", idNum: 'DL 6612-455', idExpiry: '2030-02-02', photo: null, email: 'jordan.blake@email.com', phone: '(905) 555-0301', dob: '1985-04-17', occupation: 'Taxi driver', address: '900 Markham Rd', city: 'Scarborough', province: 'ON', postal: 'M1H 2Y2', risk: 'Standard', notes: 'Monthly remittance to Mumbai.' },
    'Sarah Whitman': { kind: 'individual', idType: 'PR Card', idNum: 'PR 44871', idExpiry: '2028-11-11', photo: null, email: 'sarah.whitman@email.com', phone: '(437) 555-0312', dob: '1994-12-03', occupation: 'Graduate student', address: '21 College St', city: 'Toronto', province: 'ON', postal: 'M5G 1K2', risk: 'Standard' },
    'Marcus Reed': { kind: 'individual', idType: 'Passport', idNum: 'CZ9920184', idExpiry: '2026-05-15', photo: null, email: 'marcus.reed@email.com', phone: '(416) 555-0323', dob: '1988-06-25', occupation: 'Engineer (visitor)', address: 'Hotel — 320 King St W', city: 'Toronto', province: 'ON', postal: 'M5V 1J5', risk: 'Standard', notes: 'Visitor — tourist buy-back.' },
    'Maple Leaf Logistics Inc.': { kind: 'corporate', idType: 'Business Number', idNum: 'BN 88231', idExpiry: '2031-01-01', photo: null, email: 'fx@mapleleaflogistics.ca', phone: '(905) 555-0233', incorpDate: '2011-05-09', jurisdiction: 'Ontario, Canada', business: 'Freight & logistics', contactName: 'Dave Brooks', contactTitle: 'CFO', address: '7100 Airport Rd', city: 'Mississauga', province: 'ON', postal: 'L4T 2H3', risk: 'Enhanced', notes: 'Recurring carrier settlements in USD.' },
    'Golden Crescent Travel': { kind: 'corporate', idType: 'Business Number', idNum: 'BN 90455', idExpiry: '2030-10-10', photo: null, email: 'accounts@gctravel.ca', phone: '(416) 555-0289', incorpDate: '2016-09-12', jurisdiction: 'Ontario, Canada', business: 'Travel agency', contactName: 'Amira Said', contactTitle: 'Owner', address: '500 Bloor St W', city: 'Toronto', province: 'ON', postal: 'M5S 1Y3', risk: 'Standard', notes: 'Group travel FX floats.' }
  });

  /* ---- brand UI effects: a chime + click-pop + double-click guard for any
     permanent action (everything that writes to the audit trail). One global
     listener remembers the last button pressed; log() calls auditFx.fire(). ---- */
  const auditFx = {
    lastBtn: null, lastAt: 0, _ctx: null,
    ping() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        const ctx = auditFx._ctx || (auditFx._ctx = new AC());
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        [[660, 0], [988, 0.075]].forEach(([f, t]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
          g.gain.setValueAtTime(0.0001, now + t);
          g.gain.exponentialRampToValueAtTime(0.05, now + t + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.15);
          o.start(now + t); o.stop(now + t + 0.17);
        });
      } catch (e) {}
    },
    fire() {
      auditFx.ping();
      const el = auditFx.lastBtn;
      if (el && (Date.now() - auditFx.lastAt) < 900 && document.contains(el)) {
        el.classList.add('fx-pop'); setTimeout(() => { try { el.classList.remove('fx-pop'); } catch (e) {} }, 380);
        const prev = el.style.pointerEvents; el.style.pointerEvents = 'none';
        setTimeout(() => { try { el.style.pointerEvents = prev; } catch (e) {} }, 650);
      }
    }
  };
  if (typeof document !== 'undefined' && !window.__cdosFxBound) {
    window.__cdosFxBound = true;
    document.addEventListener('pointerdown', (e) => { const b = e.target && e.target.closest && e.target.closest('button'); auditFx.lastBtn = b || null; auditFx.lastAt = Date.now(); }, true);
  }

  /* ---- per-app accent colours: a sparse, muted identity tint so each app
     reads differently at a glance (dock glyph + open-window dot). Semantic
     where it can be — compliance is the flag red, the till is cash green. ---- */
  const APP_ACCENT = {
    rates: '#274B8E', ledger: '#1D6B45', transfers: '#1F7269', cheques: '#8F6410',
    clients: '#3C3B78', compliance: '#6B2E54', dashboard: '#17140F', assistant: '#17140F',
    till: '#17140F', vault: '#17140F', branches: '#17140F', audit: '#17140F',
    calc: '#17140F', loan: '#17140F', tagged: '#17140F', settings: '#17140F', store: '#17140F', reports: '#46506B', pricing: '#274B8E'
  };

  /* ---- shared commit button: press → flash green + lock → fire a beat later.
     One re-entrant lock means a double-click can never double-post. Mirrors the
     vault/till pattern so every consequential action confirms the same way. ---- */
  function CommitBtn({ onCommit, disabled, tone, bg, icon, doneIcon, label, doneLabel, armLabel, stage, delay, className, style, title }) {
    const { useState: uS, useRef: uR } = React;
    const [phase, setPhase] = uS('idle');   // idle → (arm) → done
    const lock = uR(false);
    const idleBg = bg || (tone === 'danger' ? CD.flag : CD.ink);
    const d = delay || 460;
    const done = phase === 'done';
    const armed = phase === 'arm';
    const fire = () => {
      if (disabled || lock.current || phase !== 'idle') return;
      lock.current = true;
      if (stage) {
        // two-stage weighty commit: flash red (arming) → green (committed) → fire
        setPhase('arm');
        setTimeout(() => setPhase('done'), Math.round(d * 0.5));
        setTimeout(() => { try { onCommit && onCommit(); } catch (e) {} }, d + Math.round(d * 0.5));
      } else {
        setPhase('done');
        setTimeout(() => { try { onCommit && onCommit(); } catch (e) {} }, d);
      }
    };
    const bgNow = disabled ? '#bdbcb3' : armed ? CD.flag : done ? CD.green : idleBg;
    const shownIcon = armed ? 'alert' : done ? (doneIcon || 'check') : icon;
    const shownLabel = armed ? (armLabel || label) : done ? (doneLabel || label) : label;
    return (
      <button type="button" onClick={fire} disabled={disabled} title={title}
        className={'cdos-commit flex-none whitespace-nowrap inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-white ' + (armed ? 'cdos-commit-arm ' : '') + (className || '')}
        style={Object.assign({ background: bgNow, borderRadius: 8, padding: '0.5rem 1rem', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background .18s ease, transform .07s ease' }, style || {})}>
        {shownIcon && <Ic n={shownIcon} s={15} c="var(--cd-on-ink)" />}{shownLabel}
      </button>
    );
  }

  // ---- client risk rating (staff-set compliance tier; light V1) ----------------
  // Every contact carries one tier. Staff set it in the profile's Edit mode; it feeds
  // the recommendation engine (High -> enhanced due diligence) and the auto-tag rules.
  // FUTURE (mapped, not built): tiers sync across the branch network so a High flag
  // raised at one store surfaces on a customer's file at every store during a check.
  // Kept on-device for now — see the roadmap in docs/.
  const RISK_TIERS = ['Normal', 'Low', 'Medium', 'High'];
  const normalizeRisk = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (s === 'low') return 'Low';
    if (s === 'medium' || s === 'enhanced') return 'Medium';
    if (s === 'high') return 'High';
    return 'Normal';
  };
  const RISK_TONE = {
    Normal: { level: 'Normal', c: CD.mute,  bg: CD.lineSoft },
    Low:    { level: 'Low',    c: CD.green, bg: CD.greenSoft },
    Medium: { level: 'Medium', c: CD.amber, bg: CD.amberSoft },
    High:   { level: 'High',   c: CD.flag,  bg: CD.flagSoft },
  };
  const riskTone = (v) => RISK_TONE[normalizeRisk(v)];

  window.CDOS = Object.assign(window.CDOS || {}, {
    CD, ICONS, Ic, TYPES, CCY, THRESHOLD, TODAY, STAFF, ROLE_CAPS, auditFx, RISK_TIERS, normalizeRisk, riskTone,
    CD_THEMES, theme: { get: themePref, set: setThemePref, resolve: resolveTheme, apply: applyTheme },
    CommitBtn, APP_ACCENT,
    crossRate, perCadLive, fmt, num, dDiff, mkRef, nowTime, newTx, seedRows, seedClients,
    publishedBook, applyBook, bookSig,
    defaultBaseline, defaultReceipts, position, holdings,
    spreadOf, unitCadMid, buyUnitCad, sellUnitCad, roundPayout, priceDeal, dealMargin
  });
})();
