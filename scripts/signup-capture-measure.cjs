/* Browser-only DOM measurement, shared with the real-DOM capture regression. */
module.exports = function measureSignup() {
        const out = [], seen = new Set();
        const keep = (e) => {
          if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          const r = e.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false;
          if (e.closest('[data-review]')) return false;
          const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          return own || /^(BUTTON|INPUT|A|SELECT|TEXTAREA)$/.test(e.tagName) || e.getAttribute('role');
        };
        document.querySelectorAll('body *').forEach((e) => {
          if (!keep(e) || seen.has(e)) return; seen.add(e);
          const c = getComputedStyle(e), r = e.getBoundingClientRect();
          out.push({
            decorativeCurrencyDrift: e.tagName === 'SPAN' && !!e.closest('[aria-hidden="true"]') && c.animationName.split(',').map(s=>s.trim()).includes('cdRise') && ['$', '€', '£', '¥'].includes(e.textContent.trim()),
            tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || undefined,
            text: (e.tagName === 'INPUT' ? '[input] ' + (e.value || e.placeholder) : /^(BUTTON|A|SUMMARY)$/.test(e.tagName) ? (e.getAttribute('aria-label') || e.innerText).replace(/\s+/g, ' ').trim() : [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim()),
            x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
            font: c.fontFamily.split(',')[0].replace(/"/g, '') + ' ' + c.fontWeight + ' ' + c.fontSize + '/' + c.lineHeight + (c.letterSpacing !== 'normal' ? ' ls ' + c.letterSpacing : ''),
            color: c.color, bg: c.backgroundColor !== 'rgba(0, 0, 0, 0)' ? c.backgroundColor : undefined,
            radius: c.borderRadius !== '0px' ? c.borderRadius : undefined,
            border: c.borderTopWidth !== '0px' ? c.borderTopWidth + ' ' + c.borderTopColor : undefined
          });
        });
        const scrollers = [...document.querySelectorAll('body *')].filter((e) => e.offsetParent && !e.closest('[data-review]') && !e.matches('[data-product]') && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4)
          .map((e) => ({ what: e.matches('[data-stage]') ? 'card body' : e.matches('[data-paybody]') ? 'payment body' : e.matches('[data-ccylist]') ? 'currency list' : e.tagName.toLowerCase(), extra: e.scrollHeight - e.clientHeight }));
        return { viewport: [innerWidth, innerHeight], pageScrolls: document.documentElement.scrollHeight > innerHeight + 1, scrollers, elements: out };
};
