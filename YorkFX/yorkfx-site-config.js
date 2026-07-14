/* ============================================================
   Site config + SMS quote widget (shared by every hosted site page)

   1) Hydration: fetches the contact/hours the OS published for this
      tenant and swaps them into any [data-site="…"] element. The
      hardcoded HTML remains as the offline/static fallback.
   2) Quote widget: "Text me this rate" — posts to the quotes API,
      which prices off the desk's published board, holds the rate 30
      minutes and texts the customer. Confirm step included.

   Works from both doors: /sites/<slug>/… paths and a customer's own
   domain (where the server resolves the site from the Host header).
   ============================================================ */
(function () {
  'use strict';
  if (typeof fetch !== 'function' || window.location.protocol === 'file:') return;

  var m = window.location.pathname.match(/\/sites\/([a-z0-9-]+)\//i);
  var SLUG = m ? m[1] : null;
  var CONFIG_URL = SLUG ? '/api/sites/' + SLUG + '/config' : '/api/site/config';
  var QUOTES_BASE = null;   // resolved once config loads (needs the slug)

  /* ---------- hydration ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hydrate(site) {
    var each = function (key, fn) { document.querySelectorAll('[data-site="' + key + '"]').forEach(fn); };
    if (site.phone) each('phone', function (el) { el.textContent = site.phone; if (el.tagName === 'A') el.href = 'tel:' + site.phone.replace(/[^\d+]/g, ''); });
    if (site.email) each('email', function (el) { el.textContent = site.email; if (el.tagName === 'A') el.href = 'mailto:' + site.email; });
    if (site.phone || site.email) each('contact', function (el) { el.innerHTML = [site.phone, site.email].filter(Boolean).map(esc).join(' · '); });
    if (site.address) each('address', function (el) {
      var line2 = [site.city, site.region, site.postal].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' $1');
      el.innerHTML = esc(site.address) + (line2 ? '<br />' + esc(line2) : '');
    });
    if (site.hours && site.hours.length) each('hours', function (el) {
      el.innerHTML = site.hours.map(function (h) { return esc(h.days) + ' ' + esc(h.hours); }).join('<br />');
    });
  }

  var SITE = null;
  fetch(CONFIG_URL).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !d.site) return;
    SITE = d.site;
    if (d.site.slug) QUOTES_BASE = '/api/sites/' + d.site.slug + '/quotes';
    hydrate(d.site);
  }).catch(function () {});

  /* ---------- SMS quote widget ---------- */
  var form = document.getElementById('quoteForm');
  if (!form) return;
  var result = document.getElementById('quoteResult');
  var btn = form.querySelector('button[type="submit"]');

  function say(html, tone) {
    if (!result) return;
    result.hidden = false;
    result.style.color = tone === 'err' ? '#c0392b' : '';
    result.innerHTML = html;
  }
  function fmt(n, c) { return Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + c; }
  function until(ts) { return new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var amount = parseFloat(String(document.getElementById('qAmount').value).replace(/[^\d.]/g, ''));
    var from = document.getElementById('qFrom').value;
    var to = document.getElementById('qTo').value;
    var phone = document.getElementById('qPhone').value.trim();
    if (!amount || amount <= 0) { say('Enter the amount you’re exchanging.', 'err'); return; }
    if (from === to) { say('Pick two different currencies.', 'err'); return; }
    if (!phone) { say('Enter a mobile number we can text.', 'err'); return; }
    if (!QUOTES_BASE) { say('Quotes are offline right now — call the desk' + (SITE && SITE.phone ? ' at ' + esc(SITE.phone) : '') + '.', 'err'); return; }

    btn.disabled = true; btn.textContent = 'Getting your rate…';
    fetch(QUOTES_BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: phone, from: from, to: to, amount: amount }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Text me this rate — held 30 min';
        if (!res.ok) { say(esc((res.d && res.d.detail) || 'Couldn’t get a quote — try again or call the desk.'), 'err'); return; }
        var q = res.d.quote;
        form.querySelectorAll('input, select, button[type="submit"]').forEach(function (el) { el.closest('.two') ? el.closest('.two').style.display = 'none' : el.style.display = 'none'; });
        say(
          '<div style="border:1px solid rgba(0,0,0,0.14); border-radius:12px; padding:16px 18px; font-size:14px; line-height:1.65;">' +
            '<div style="font-size:11px; letter-spacing:0.1em; text-transform:uppercase; opacity:0.6;">Rate held · ref ' + esc(q.ref) + '</div>' +
            '<div style="font-size:20px; font-weight:800; margin:6px 0 2px;">' + fmt(q.amount, q.from) + ' → ' + fmt(q.receive, q.to) + '</div>' +
            '<div>Held for you until <b>' + until(q.expiresAt) + '</b>.' + (q.smsStatus === 'simulated' ? ' (SMS preview — texting goes live soon.)' : ' We’ve texted the details to ' + esc(q.phone) + '.') + '</div>' +
            '<button type="button" id="quoteConfirm" class="btn btn-solid" style="margin-top:12px;">I’m coming — set it aside</button>' +
            '<div id="quoteConfirmNote" style="margin-top:8px;"></div>' +
          '</div>'
        );
        var cbtn = document.getElementById('quoteConfirm');
        cbtn.addEventListener('click', function () {
          cbtn.disabled = true;
          fetch(QUOTES_BASE + '/' + encodeURIComponent(q.ref) + '/confirm', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var note = document.getElementById('quoteConfirmNote');
              if (d.quote && d.quote.status === 'confirmed') { cbtn.style.display = 'none'; note.innerHTML = '<b>Confirmed.</b> Your ' + fmt(q.receive, q.to) + ' is set aside until ' + until(q.expiresAt) + ' — ref ' + esc(q.ref) + '.'; }
              else { cbtn.disabled = false; note.textContent = 'Couldn’t confirm — the hold may have expired.'; }
            })
            .catch(function () { cbtn.disabled = false; });
        });
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Text me this rate — held 30 min';
        say('Couldn’t reach the desk — try again in a moment.', 'err');
      });
  });
})();
