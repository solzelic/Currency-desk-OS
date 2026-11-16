/* The first Home uses the authenticated tenant, without opening a till.
   This is the signup welcome underlay, not the subsequent walkthrough. */
(function () {
  'use strict';
  const CDOS = window.CDOS;
  CDOS.signupHomeFromSession = async function (user) {
    if (window.parent === window || new URLSearchParams(location.search).get('onboarding') !== 'welcome' || user.role !== 'administrator') return null;
    try {
      const response = await fetch('/api/tenant', { credentials: 'same-origin' });
      if (!response.ok) return null;
      const tenant = (await response.json()).tenant;
      return tenant && tenant.id === user.tenantId && tenant.setup && tenant.setup.signup && tenant.setup.signup.version === '2.1' ? tenant : null;
    } catch (e) { return null; }
  };
  CDOS.SignupHome = function ({ tenant, owner }) {
    const h = React.createElement, setup = tenant.setup || {}, signup = setup.signup || {};
    React.useEffect(function () {
      window.parent.postMessage({ type: 'cd-signup-home-ready', tenantId: tenant.id }, location.origin);
    }, [tenant.id]);
    const cards = [
      ['Your shop', tenant.name],
      ['Opening cash', signup.vaultCountStatus === 'deferred' ? 'Count the safe before the first shift' : 'Saved count awaits ledger confirmation'],
      ['Your team', 'Staff access and invitations need activation'],
      ['First shift', 'No till has been claimed by this welcome screen'],
    ];
    return h('section', { 'data-signup-home': tenant.id, 'aria-label': 'Home', style: { maxWidth: 780, margin: '0 auto', padding: '38px 18px 60px' } },
      h('h1', { style: { fontSize: 26, margin: '0 0 22px', fontFamily: 'var(--cd-serif)' } }, 'Welcome, ' + owner),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 14, filter: 'blur(5px)', opacity: .55 } },
        cards.map(([title, text]) => h('div', { key: title, style: { border: '1px solid var(--cd-line)', borderRadius: 16, background: 'var(--cd-paper)', padding: 22 } }, h('h2', { style: { fontSize: 16 } }, title), h('p', null, text)))));
  };
})();
