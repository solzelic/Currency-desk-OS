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
    telegraphbubble:'<g transform="translate(-1.8 -1.8) scale(1.15)" stroke-width="1.74"><path d="M6.5 4.5 H17.5 A3 3 0 0 1 20.5 7.5 V12 A3 3 0 0 1 17.5 15 H10.5 L6.5 19 L8 15 H6.5 A3 3 0 0 1 3.5 12 V7.5 A3 3 0 0 1 6.5 4.5 Z" stroke="#17140F"/><path d="M8 9.75 H8.02 M12 9.75 H12.02 M16 9.75 H16.02" stroke="#1D6B45"/></g>',
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
  /* ============================================================
     TWO KINDS OF "TODAY", AND THEY ARE NOT THE SAME THING

     This line used to read `const TODAY = '2026-06-18'`. Every New
     Transaction ticket was headed with that date while the server posted
     the deal under the real one; cash-rail movements were minted with
     references like MV-260618-01; and the drawer's history table labelled
     the 2026-06-18 row TODAY under a session banner showing the real
     date. A teller read a seven-week-old date back to a customer, and an
     audit trail carried it.

     There are two distinct questions behind the word, and a call site
     wants exactly one of them:

       wallClock()     what time is it, on this machine, right now.
                       For "posted at 14:32", for greeting somebody good
                       morning, for the clock in a receipt footer.

       businessDate()  which TRADING DAY the desk is working in. The till
                       session carries it (`business_date`), the server
                       decides it, and it is what belongs on a movement
                       reference, a day's close-out and anything that has
                       to line up with the book afterwards. A branch that
                       opened its session before midnight is still on
                       yesterday's business date at 00:05, and that is the
                       correct answer, not a bug.

     They coincide most of the time, which is precisely why getting them
     confused is cheap to do and expensive to find.

     `TODAY` remains exported as the wall-clock date so that files this
     change does not own keep working — but it is a SNAPSHOT taken when
     the page loaded. Anything that must survive a desk left open
     overnight should call wallClock() or businessDate() instead. */
  const wallClock = () => new Date().toLocaleDateString('en-CA');   // YYYY-MM-DD, local
  /* What the server says this till's trading day is. Null until a session
     has been read — and null means "not known yet", so businessDate()
     falls back to the wall clock rather than to a made-up date. */
  let _businessDate = null;
  const businessDate = () => _businessDate || wallClock();
  const setBusinessDate = (date) => {
    const next = date ? String(date).slice(0, 10) : null;
    if (next === _businessDate) return _businessDate;
    _businessDate = next;
    try { window.dispatchEvent(new CustomEvent('cdos-business-date', { detail: { date: _businessDate } })); } catch (e) {}
    return _businessDate;
  };
  /* Ask the ledger which trading day this till is in. Cheap, idempotent,
     and safe before sign-in — an unauthenticated answer simply leaves the
     business date unknown and the wall clock standing in for it. */
  async function refreshBusinessDate() {
    try {
      const B = window.CDOS && window.CDOS.Backend;
      if (!B) return businessDate();
      const answer = await B.loadTillSession();
      if (answer && answer.session && answer.session.businessDate) setBusinessDate(answer.session.businessDate);
    } catch (e) { /* no session, no server, or not signed in: the clock stands in */ }
    return businessDate();
  }
  /* The window a "today" figure covers, as two instants, from the desk's
     own midnight. The server deliberately refuses to guess this — see the
     note on LedgerReportingService.summary — because a business day
     belongs to a branch's clock and this browser is standing in the
     branch. `days` looks back that many days from the business date. */
  function businessDayWindow(days) {
    const end = new Date(businessDate() + 'T00:00:00');
    end.setDate(end.getDate() + 1);
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(1, days || 1));
    return { from: start.toISOString(), to: end.toISOString() };
  }
  const TODAY = wallClock();

  /* ============================================================
     THE REPORTING LINE — one number, in the desk's own money

     `const THRESHOLD = 10000` sat here, hardcoded, in Canadian dollars.
     The Ledger flagged reportable rows against it, warned the teller
     against it and printed it in the report footer; Reports used it in
     four more places. Meanwhile Compliance, LCTR, KYC and the Dashboard
     all honoured `settings.threshold` through getRegime(). The same desk
     flagged at two different numbers on two different screens, and a UAE
     desk operating on 55,000 AED got a Canadian figure with a dollar sign
     in front of it.

     reportingLimit() is the one answer. In precedence order:

       1. what the DESK has set           the server's per-entity override
       2. what the jurisdiction pack says the server's pack, per entity
       3. what the owner set in Settings  settings.threshold
       4. what the regime engine says     getRegime(), the browser's packs

     and the currency comes from the pack first, because home currency is
     the pack's to state — it is the whole point of shipping a Canada pack
     and a UK pack rather than hardcoding one country.

     Note where the owner's setting now sits. It used to be first, and it
     was browser state: whatever this browser profile last saved. That is
     the wrong authority for a compliance line — the second till at the
     same desk held its own copy, a cleared browser held none, and the
     server enforcing the ID gate could not see any of it. The desk's
     number now lives on the ledger and comes back at (1); (3) survives
     only for the standalone build, which has no server to ask.

     `amount` is null when nothing can answer. A screen showing a
     threshold it cannot state must say so; flagging every deal against a
     number nobody chose is how this went wrong the first time. */
  let _pack = null;
  const deskPack = () => _pack;
  /* The forms this jurisdiction files, alongside the pack that defines
     them — the filing portal, the aggregation window, the trigger amount.
     They arrive in the same answer as the pack and were being dropped on
     the floor, so the LCTR worksheet issued its own duplicate request per
     session to get them back. Kept together because they are one fact. */
  let _reports = [];
  const deskReports = () => _reports;
  const setDeskPack = (pack, reports) => {
    _pack = pack || null;
    if (reports !== undefined) _reports = Array.isArray(reports) ? reports : [];
    try { window.dispatchEvent(new CustomEvent('cdos-jurisdiction', { detail: { pack: _pack, reports: _reports } })); } catch (e) {}
    return _pack;
  };
  async function refreshJurisdiction() {
    try {
      const B = window.CDOS && window.CDOS.Backend;
      if (!B) return _pack;
      const answer = await B.loadJurisdiction();
      if (answer && answer.pack) setDeskPack(answer.pack, answer.reports);
    } catch (e) { /* not signed in, or a desk with no pack yet */ }
    return _pack;
  }
  /* The desk's own lines, as the ledger resolved them: each of
     reportThreshold / idThreshold / aggregationHours / retentionYears as
     { effective, deskChoice, packValue, posture }. Cached in module state
     beside the pack and refreshed by the same hook, because every screen
     that shows a threshold wants the same answer and none of them should
     be asking for itself. */
  let _thresholds = null;
  const deskThresholds = () => _thresholds;
  const setDeskThresholds = (answer) => {
    _thresholds = answer || null;
    try { window.dispatchEvent(new CustomEvent('cdos-thresholds', { detail: { thresholds: _thresholds } })); } catch (e) {}
    return _thresholds;
  };
  async function refreshDeskThresholds() {
    try {
      const B = window.CDOS && window.CDOS.Backend;
      if (!B) return _thresholds;
      const answer = await B.loadDeskThresholds();
      if (answer && answer.idThreshold) setDeskThresholds(answer);
    } catch (e) { /* not signed in, or the standalone build with no server */ }
    return _thresholds;
  }
  const _positive = (v) => v != null && v !== '' && !isNaN(v) && +v > 0;
  /* One resolved line off the server's answer, or null. `effective` is
     already the desk's choice where it made one and the pack's where it
     did not — the precedence was decided on the server, once, so that the
     number the screen prints and the number the gate enforces cannot
     drift apart. */
  const _serverLine = (key) => {
    const line = _thresholds && _thresholds[key];
    return line && _positive(line.effective) ? +line.effective : null;
  };
  function reportingLimit(settings) {
    const regime = (window.CDOS && window.CDOS.getRegime) ? window.CDOS.getRegime(settings) : null;
    const amount = _serverLine('reportThreshold') != null ? _serverLine('reportThreshold')
      : (_pack && _positive(_pack.reportThreshold)) ? +_pack.reportThreshold
      : _positive(settings && settings.threshold) ? +settings.threshold
      : (regime && _positive(regime.threshold)) ? +regime.threshold
      : null;
    const currency = (_pack && _pack.homeCurrency)
      || (settings && settings.baseCurrency)
      || (regime && regime.currency)
      || null;
    return {
      amount,
      currency,
      /* What the regulator calls the report this line triggers — "LCTR"
         in Canada, "CTR" in the United States. Screens print it; none of
         them should be spelling it out for themselves. */
      /* THE PACK FIRST. getRegime() falls back to FINTRAC whenever
         settings.regime is unset, so reading it first handed a London desk
         the code "LCTR" — a Canadian form, named confidently, on a report
         the desk does not file. The pack is the thing that actually knows
         which form this jurisdiction uses. */
      code: (_pack && _pack.reportName) || (regime && regime.largeCode) || 'report',
      label: amount == null || !currency ? '—' : fmt(amount, currency),
    };
  }
  /* Is this deal over the line? Null-safe on purpose: with no threshold to
     compare against, the honest answer is "cannot say", and a screen that
     turns that into `false` has quietly cleared a deal nobody checked. */
  const overReportingLimit = (homeAmount, settings) => {
    const limit = reportingLimit(settings);
    return limit.amount == null ? null : (+homeAmount || 0) >= limit.amount;
  };
  /* The line at which this desk asks for identification — the other half
     of the pair, and the one the LEDGER refuses a deal at. Same
     precedence, same currency, same null. A screen quoting a different
     number from the one the server will enforce is how a teller ends up
     arguing with a refusal they were told would not come. */
  function identificationLimit(settings) {
    const regime = (window.CDOS && window.CDOS.getRegime) ? window.CDOS.getRegime(settings) : null;
    const amount = _serverLine('idThreshold') != null ? _serverLine('idThreshold')
      : (_pack && _positive(_pack.idThreshold)) ? +_pack.idThreshold
      : _positive(settings && settings.idRequiredOver) ? +settings.idRequiredOver
      : (regime && _positive(regime.idAt)) ? +regime.idAt
      : null;
    const currency = (_thresholds && _thresholds.currency)
      || (_pack && _pack.homeCurrency)
      || (settings && settings.baseCurrency)
      || (regime && regime.currency)
      || null;
    return { amount, currency, label: amount == null || !currency ? '—' : fmt(amount, currency) };
  }
  /* Staff directory seed. Per the Branch & Access Model spec: a role carries
     capabilities (ROLE_CAPS) AND a scope (ROLE_SCOPE); assignments say WHERE
     the role applies — branches: '*' (owner) or an array of branch ids, with
     one home branch. S. Iqbal is deliberately unassigned to demo the R1 stop
     screen. The live, editable copy lives in settings.employees. */
  /* EVERY ONE OF THESE IS MARKED `demo`, AND THAT MATTERS.

     These five are the rehearsal desk's staff. On a browser that has never
     signed in to a real desk they are the whole directory — which is fine
     for the demo and was quietly wrong on the sign-in screen, where they
     were offered to real returning customers as EXAMPLES of what to type.
     Somebody who runs their own shop was being shown two strangers' staff
     IDs and told to pick one.

     The flag is what lets that screen tell "this desk's people" from
     "nobody's people". Anything adopted from the server is unmarked. */
  const STAFF = [
    { name: 'J. Masri',  role: 'Owner',         staffId: 'j.masri',  branches: '*',            home: null, demo: true },
    { name: 'R. Haddad', role: 'Manager',       staffId: 'r.haddad', branches: ['b02'],        home: 'b02', demo: true },
    { name: 'A. Singh',  role: 'Senior teller', staffId: 'a.singh',  branches: ['b01'],        home: 'b01', demo: true },
    { name: 'M. Costa',  role: 'Cashier',       staffId: 'm.costa',  branches: ['b01', 'b02'], home: 'b01', demo: true },
    { name: 'S. Iqbal',  role: 'Trainee',       staffId: 's.iqbal',  branches: [],             home: null, demo: true },
  ];
  /* scope axis: how much of the network a role can see/act on.
     network = everything · branch = their assigned branch(es), all tills
     till = their assigned till only (no self-serve till switching) */
  const ROLE_SCOPE = { 'Owner': 'network', 'Manager': 'branch', 'Senior teller': 'branch', 'Cashier': 'till', 'Trainee': 'till' };
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
     THE SECOND BOOK — THIS IS ITS HEADSTONE

     What stood here was `position(c, rows, baseline, receipts)`: a pure
     function that DERIVED the desk's cash from an opening baseline plus
     every posted record. It was a good function and it was the wrong
     idea. The server ledger STORES cash — a row in ledger_till_balances
     and ledger_vault_balances that movements update — and neither model
     was ever declared authoritative over the other. Every cash defect
     this project has had lived exactly where the two met, and none of
     them crashed. Two books do not crash; they disagree quietly, and the
     daily close overwrites the evidence. See
     docs/CASH_OWNERSHIP_INVARIANTS.md.

     The baseline it started from was a demo seed — 238,500 CAD and eight
     other currencies nobody had counted — which is how the Vault came to
     announce $594,124.00 on hand for a safe that was empty, and how the
     Dashboard reported the desk SHORT the euros it was long.

     There is nothing here now. Cash comes from GET /api/ledger/position
     and GET /api/ledger/till-balances, and a figure the ledger has no row
     for is shown as absent rather than derived. See docs/ABSENT_FIGURES.md.

     `defaultBaseline` and `defaultReceipts` survive as EMPTY only because
     two call sites in files this change does not own invoke them
     unconditionally at start-up, and deleting them would black-screen the
     desk rather than fix it:

       os-src/cdos-os.jsx:769-770  — the `baseline` / `receipts` state
       os-src/cdos-os.jsx:1799-1800, 1869 — the same on tenant switch/reset

     Those states, and every prop threading them down to the Till, the
     Vault, Reports and Compliance, are the remaining work. They now carry
     nothing, so nothing reads a cash figure out of them. */
  function defaultBaseline() { return { anchor: null, units: {}, cost: {} }; }
  function defaultReceipts() { return []; }
  /* Deriving stock from transactions is the second book, so there is no
     derivation left to call. It answers null — "the ledger has no figure
     here" — rather than a number, because null is the one answer a screen
     cannot mistake for money. One caller in a file this change does not
     own still reaches for it:

       os-src/cdos-till.jsx:485 — the drawer's `expectedOf` in the
       standalone (no-server) mode. It should read

         const expectedOf = (c) => serverBalances &&
           Object.prototype.hasOwnProperty.call(serverBalances, c)
             ? Number(serverBalances[c]) : null;

       and render null as "—". A desk that cannot reach the ledger has no
       expected float; docs/CASH_OWNERSHIP_INVARIANTS.md is explicit that
       there is no offline mode, and an invented expected figure is what a
       teller reconciles a real drawer against. */
  const holdings = () => null;

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
      /* the TRADING day, not the wall clock — a record's date is what it
         has to line up with in the book afterwards */
      ref: '', date: businessDate(), time: nowTime(),
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

  /* ============================================================
     THE DEMO BOOK — ALSO GONE

     `seedRows()` returned thirty-eight invented transactions dated
     2026-06-18, and `seedClients()` the eighteen people who supposedly
     made them. They were the browser's whole book before the server had
     one, and they are the reason a desk that had posted a single $1,000
     trade opened on a Ledger header reading "38 records · $130,566.36
     pay-in · $1,051.86 fees" and a Dashboard claiming $1,150 earned.

     A brand-new desk must not come up showing York FX's trading. The book
     is GET /api/ledger/transactions and nothing else; a desk with nothing
     posted shows nothing posted, which is both true and the thing an
     owner needs to see on their first morning.

     Both survive as empty because cdos-os.jsx:714-715 calls them to
     initialise its `rows` and `clients` state before any server round
     trip. Empty is the correct starting value for that state. */
  const seedRows = () => [];
  const seedClients = () => ({});

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
    calc: '#17140F', loan: '#17140F', tagged: '#17140F', settings: '#17140F', store: '#17140F', reports: '#46506B', pricing: '#274B8E', telegraph: '#8A4B2F'
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

  /* ---- the two facts every screen needs before it can render honestly ----
     Which trading day this till is in, and which rules the desk trades
     under. Both live on the server, both are cheap, and both are cached in
     module state — so this hook asks for them once per mounted screen and
     returns a version number that changes when either arrives. Put it in a
     memo's dependencies and the figures re-derive when the answer lands
     instead of a moment too late.

     Deliberately NOT a hard dependency: a screen renders immediately with
     the wall-clock date and no threshold, and reportingLimit() reports "—"
     until the pack is known. A dash for half a second beats a Canadian
     10,000 on a UAE desk forever. */
  function useDeskFacts() {
    const [version, setVersion] = React.useState(0);
    React.useEffect(() => {
      let live = true;
      const bump = () => { if (live) setVersion(v => v + 1); };
      window.addEventListener('cdos-jurisdiction', bump);
      window.addEventListener('cdos-thresholds', bump);
      window.addEventListener('cdos-business-date', bump);
      Promise.all([
        refreshJurisdiction(),
        /* The desk's own lines, alongside the pack that proposes them. A
           screen that had the pack but not the override would print the
           regulator's 10,000 at a desk that had deliberately moved to
           7,500 — the exact class of disagreement this hook exists to
           stop, so the two arrive together or the version does not move. */
        refreshDeskThresholds(),
        refreshBusinessDate(),
      ]).then(bump, bump);
      return () => {
        live = false;
        window.removeEventListener('cdos-jurisdiction', bump);
        window.removeEventListener('cdos-thresholds', bump);
        window.removeEventListener('cdos-business-date', bump);
      };
    }, []);
    return version;
  }

  /* ---- a figure the ledger has no answer for ----------------------------
     One dash, one reason, everywhere. The rule is written down in
     docs/ABSENT_FIGURES.md and it is short: a figure with no server row is
     shown as absent, visibly — never as zero, never as a demo number,
     never as a confident-looking total. "—" with a line saying why beats a
     bold $594,124.00 that is fiction.

     The `why` is not optional and not decoration. "—" on its own reads as
     a rendering fault; "— nothing posted yet today" reads as an answer,
     and it is one. Keep it short and factual: what is missing, and what
     would fill it in. */
  function Absent({ why, size, align }) {
    return (<span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: align === 'right' ? 'flex-end' : 'flex-start', lineHeight: 1.25 }}>
      <span style={{ fontSize: size || 20, fontWeight: 700, color: CD.faint, fontFamily: 'Space Mono, monospace' }}>—</span>
      {why && <span style={{ fontSize: 10.5, color: CD.faint, marginTop: 2, textAlign: align === 'right' ? 'right' : 'left' }}>{why}</span>}
    </span>);
  }
  /* Render a server money field, or say it is absent. `value` is whatever
     the ledger sent: a decimal string, or null. There is deliberately no
     "default to 0" branch — that default is the bug this exists to stop. */
  const money = (value, currency, why, opts) => value == null
    ? <Absent why={why} size={(opts && opts.size) || 20} align={opts && opts.align} />
    : fmt(value, currency || 'CAD');

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

  /* ---- shared 4-digit PIN gate: reused at account switch, till switch, void.
     A proper mandatory-PIN screen — dot indicators + on-screen keypad, and the
     physical keyboard works too. ---- */
  function PinPrompt({ title, sub, name, staffId, expected, onOk, onCancel }) {
    const [pin, setPin] = React.useState('');
    const [err, setErr] = React.useState('');
    const [shake, setShake] = React.useState(false);
    const exp = String(expected == null ? '0000' : expected);
    const ini = (nm) => (nm || '?').split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    React.useEffect(() => {
      if (!document.getElementById('cdos-pin-kf')) { const s = document.createElement('style'); s.id = 'cdos-pin-kf'; s.textContent = '@keyframes cdosPinShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}'; document.head.appendChild(s); }
    }, []);
    const fail = (msg) => { setErr(msg || 'Incorrect PIN'); setShake(true); setTimeout(() => setShake(false), 420); setTimeout(() => { setPin(''); }, 260); };
    /* The server decides. Holding the expected PIN in the browser and
       comparing it here made this gate decorative — it could be read out of
       devtools, or stepped over entirely. A desk whose PINs have not been set
       on the server yet answers 409, and only then do we fall back to the old
       local check so nothing breaks mid-migration. */
    const submit = async (val) => {
      try {
        const res = await fetch('/api/staff/pin/verify', {
          method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify(staffId ? { staffId: staffId, pin: val } : { pin: val }),
        });
        if (res.ok) { onOk && onOk(); return; }
        if (res.status === 429) { fail('Too many tries — wait a few minutes'); return; }
        if (res.status === 401) { fail(); return; }
        if (res.status !== 409) { fail('Could not check that PIN'); return; }
      } catch (e) { /* offline: the local check is all there is */ }
      if (val === exp) { onOk && onOk(); } else { fail(); }
    };
    const press = (dgt) => { setErr(''); setPin(p => { if (p.length >= 4) return p; const n = p + dgt; if (n.length === 4) setTimeout(() => submit(n), 90); return n; }); };
    const back = () => { setErr(''); setPin(p => p.slice(0, -1)); };
    React.useEffect(() => {
      const h = (e) => {
        if (e.key === 'Escape') { onCancel && onCancel(); return; }
        if (e.key === 'Backspace') { e.preventDefault(); back(); return; }
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); }
      };
      document.addEventListener('keydown', h);
      return () => document.removeEventListener('keydown', h);
    }, []);
    const keyBtn = (label, onClick, kind) => (
      <button key={label + kind} onClick={onClick} style={{ height: 56, borderRadius: 13, border: kind === 'ghost' ? '0' : `1px solid ${CD.line}`, background: kind === 'ghost' ? 'transparent' : 'var(--cd-panel)', fontSize: 22, fontWeight: 600, fontFamily: 'Space Mono, monospace', color: CD.ink, cursor: 'pointer', display: 'grid', placeItems: 'center', transition: 'background .1s, transform .05s', WebkitTapHighlightColor: 'transparent' }}
        onMouseDown={e => { e.currentTarget.style.background = CD.hover; e.currentTarget.style.transform = 'scale(0.97)'; }}
        onMouseUp={e => { e.currentTarget.style.background = kind === 'ghost' ? 'transparent' : 'var(--cd-panel)'; e.currentTarget.style.transform = 'none'; }}
        onMouseLeave={e => { e.currentTarget.style.background = kind === 'ghost' ? 'transparent' : 'var(--cd-panel)'; e.currentTarget.style.transform = 'none'; }}>
        {label}
      </button>
    );
    return ReactDOM.createPortal(
      <div style={{ position: 'fixed', inset: 0, background: 'var(--cd-scrim)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)', zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onMouseDown={() => onCancel && onCancel()}>
        <div onMouseDown={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 320, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 18, boxShadow: '0 30px 70px var(--cd-scrim)', padding: '24px 22px 18px', textAlign: 'center', animation: shake ? 'cdosPinShake .42s' : 'none' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: CD.faint, fontFamily: 'Space Mono, monospace', border: `1px solid ${CD.line}`, borderRadius: 999, padding: '3px 9px', marginBottom: 14 }}><Ic n="lock" s={10} c={CD.faint} /> PIN required</div>
          <div style={{ width: 52, height: 52, borderRadius: '50%', background: CD.ink, color: 'var(--cd-on-ink)', display: 'grid', placeItems: 'center', fontFamily: 'Space Mono, monospace', fontWeight: 700, fontSize: 16, margin: '0 auto 10px' }}>{ini(name)}</div>
          <div style={{ fontSize: 16.5, fontWeight: 700, color: CD.ink, letterSpacing: '-0.01em' }}>{title || 'Enter your PIN'}</div>
          <div style={{ fontSize: 11.5, color: CD.mute, marginTop: 3 }}>{sub || name || ''}</div>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', margin: '18px 0 6px' }}>
            {[0, 1, 2, 3].map(i => { const filled = i < pin.length; return <span key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: filled ? (err ? CD.flag : CD.ink) : 'transparent', border: `2px solid ${err ? CD.flag : (filled ? CD.ink : CD.line)}`, transition: 'background .12s, border-color .12s' }} />; })}
          </div>
          <div style={{ fontSize: 11.5, color: CD.flag, minHeight: 18, marginBottom: 8 }}>{err}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => keyBtn(k, () => press(k)))}
            {keyBtn('Cancel', () => onCancel && onCancel(), 'ghost')}
            {keyBtn('0', () => press('0'))}
            {keyBtn(<Ic n="arrowleft" s={20} c={CD.mute} />, back, 'ghost')}
          </div>
        </div>
      </div>, document.body);
  }


  window.CDOS = Object.assign(window.CDOS || {}, {
    CD, ICONS, Ic, TYPES, CCY, TODAY, STAFF, ROLE_CAPS, ROLE_SCOPE, auditFx, RISK_TIERS, normalizeRisk, riskTone,
    CD_THEMES, theme: { get: themePref, set: setThemePref, resolve: resolveTheme, apply: applyTheme },
    CommitBtn, APP_ACCENT, PinPrompt, Absent, money,
    crossRate, perCadLive, fmt, num, dDiff, mkRef, nowTime, newTx, seedRows, seedClients,
    publishedBook, applyBook, bookSig,
    defaultBaseline, defaultReceipts, holdings,
    /* the two "todays", kept apart on purpose — see the note above */
    wallClock, businessDate, setBusinessDate, refreshBusinessDate, businessDayWindow,
    /* the one reporting line, and the pack it comes from */
    reportingLimit, overReportingLimit, identificationLimit,
    deskPack, deskReports, setDeskPack, refreshJurisdiction, useDeskFacts,
    /* the desk's own lines, as the ledger resolved them against the pack */
    deskThresholds, setDeskThresholds, refreshDeskThresholds,
    spreadOf, unitCadMid, buyUnitCad, sellUnitCad, roundPayout, priceDeal, dealMargin
  });
})();
