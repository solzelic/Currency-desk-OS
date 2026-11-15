/* Exchange v2.9 screens: the 24 hour meter (CD-235) and the ID check
   chooser when this shop has no earlier check.
   Prices on the chooser are display copy. Nothing here bills the shop.
   The chooser never asks about another shop. */
(function () {
  var R = function () { return (window.CDOS && window.CDOS.exchangeV29) || {}; };
  var NO_EARLIER = "No earlier check at this shop. A new check is needed.";
  var FOOTER = "Holds count once any cash moves.";

  function money(value) {
    if (value == null || value === "") return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function Meter(props) {
    var posted = props.postedTotal;
    var heldCash = props.heldCountedTotal;
    var rows = props.heldNotCounted || [];
    var rules = R();
    var footer = (rules.HOLD_FOOTER) || FOOTER;
    var label = (rules.HELD_NOT_COUNTED) || "Held, not counted";
    var counts = null;
    if (posted != null && heldCash != null) {
      var sum = (Number(posted) + Number(heldCash));
      counts = Number.isFinite(sum) ? sum.toFixed(2) : null;
    }
    return React.createElement("section", { className: "cd-v29-meter", "aria-label": "Last 24 hours" },
      React.createElement("div", { className: "cd-v29-kicker" }, "Last 24 hours. What counts"),
      React.createElement("div", { className: "cd-v29-row" },
        React.createElement("span", null, "Posted"),
        React.createElement("b", null, money(posted) == null ? "Not available" : money(posted))
      ),
      React.createElement("div", { className: "cd-v29-row" },
        React.createElement("span", null, "Holds where cash moved"),
        React.createElement("b", null, money(heldCash) == null ? "Not available" : money(heldCash))
      ),
      React.createElement("div", { className: "cd-v29-row cd-v29-total" },
        React.createElement("span", null, "Counts"),
        React.createElement("b", null, money(counts) == null ? "Not available" : money(counts))
      ),
      React.createElement("div", { className: "cd-v29-held" },
        React.createElement("div", { className: "cd-v29-kicker" }, label),
        rows.length
          ? rows.map(function (row) {
              return React.createElement("div", { key: row.holdId, className: "cd-v29-row" },
                React.createElement("span", null, label),
                React.createElement("b", null, row.cashHome ? money(row.cashHome) : "No cash moved")
              );
            })
          : React.createElement("div", { className: "cd-v29-quiet" }, "No hold is waiting without cash.")
      ),
      React.createElement("p", { className: "cd-v29-footer" }, footer)
    );
  }

  function Card(props) {
    return React.createElement("button", {
      type: "button",
      disabled: props.disabled,
      onClick: props.disabled ? undefined : props.onPick,
      className: "cd-v29-card" + (props.recommended ? " is-rec" : "") + (props.disabled ? " is-off" : ""),
      "aria-disabled": props.disabled ? "true" : "false",
    },
      props.badge ? React.createElement("span", { className: "cd-v29-badge" }, props.badge) : null,
      React.createElement("div", { className: "cd-v29-kicker" }, props.kicker),
      React.createElement("div", { className: "cd-v29-title" }, props.title),
      props.price ? React.createElement("div", { className: "cd-v29-price" }, props.price) : null,
      React.createElement("p", null, props.body)
    );
  }

  function Chooser(props) {
    var reason = props.reason || NO_EARLIER;
    return React.createElement("div", { className: "cd-v29-over", role: "presentation" },
      React.createElement("div", { className: "cd-v29-sheet", role: "dialog", "aria-label": "Choose an ID check" },
        React.createElement("div", { className: "cd-v29-kicker" }, "ID check. Prices first"),
        React.createElement("h2", null, "Choose an ID check."),
        React.createElement("p", { className: "cd-v29-lead" }, "A check stays on file at this shop, so the next teller does not pay for it again."),
        React.createElement("div", { className: "cd-v29-cards" },
          React.createElement(Card, {
            recommended: true,
            badge: "Recommended",
            kicker: "At the counter",
            title: "In person",
            price: "Free",
            body: "You inspect the original photo ID and match the face. A full ID check.",
            onPick: props.onInPerson,
          }),
          React.createElement(Card, {
            disabled: props.returningOff !== false,
            kicker: "Re-check",
            title: "Returning client",
            price: "$3.99 CAD",
            body: reason,
          }),
          React.createElement(Card, {
            badge: "Also good",
            kicker: "Standard",
            title: "ID and selfie",
            price: "$6.99 CAD",
            body: "Photo ID checked as authentic, with a live selfie and face match.",
            onPick: props.onSelfie,
          }),
          React.createElement(Card, {
            kicker: "Most checks",
            title: "ID, selfie and database",
            price: "$14.99 CAD",
            body: "Adds a Canadian credit file or two independent sources.",
            onPick: props.onDatabase,
          })
        ),
        React.createElement("p", { className: "cd-v29-note" }, "Prices are display copy, paid by the shop, shown before you run a check. A name check is not connected here."),
        React.createElement("div", { className: "cd-v29-actions" },
          React.createElement("button", { type: "button", className: "cd-v29-go", onClick: props.onInPerson }, "Check ID in person. Free"),
          React.createElement("button", { type: "button", className: "cd-v29-quiet-btn", onClick: props.onClose }, "Not now")
        )
      )
    );
  }

  var css = [
    ".cd-v29-meter{margin-top:10px;padding:12px;border:1px solid var(--cd-line,#e6e1d8);border-radius:12px;background:var(--cd-panel,#fff);font-size:12.5px;line-height:1.4}",
    ".cd-v29-kicker{font-family:'Space Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8a847a;margin-bottom:6px}",
    ".cd-v29-row{display:flex;justify-content:space-between;gap:8px;padding:3px 0}",
    ".cd-v29-total{font-weight:700;border-top:1px solid var(--cd-line,#e6e1d8);margin-top:4px;padding-top:6px}",
    ".cd-v29-held{margin-top:8px;padding-top:6px}",
    ".cd-v29-footer{margin:8px 0 0;color:#5c564e;font-size:12px}",
    ".cd-v29-quiet{color:#8a847a}",
    ".cd-v29-over{position:fixed;inset:0;background:rgba(40,36,30,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;z-index:80;overflow:auto}",
    ".cd-v29-sheet{width:min(920px,100%);background:#f7f4ed;border-radius:18px;padding:22px 20px 16px;box-shadow:0 18px 50px rgba(0,0,0,.18)}",
    ".cd-v29-sheet h2{font-size:28px;line-height:1.15;margin:4px 0 8px;font-weight:650}",
    ".cd-v29-lead{margin:0 0 12px;color:#3f3a34}",
    ".cd-v29-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}",
    "@media (max-width:800px){.cd-v29-cards{grid-template-columns:1fr 1fr}}",
    "@media (max-width:520px){.cd-v29-cards{grid-template-columns:1fr}}",
    ".cd-v29-card{position:relative;text-align:left;border:1px solid #e4dfd6;background:#fff;border-radius:14px;padding:14px 12px 12px;min-height:180px;cursor:pointer}",
    ".cd-v29-card.is-rec{border:2px solid #2f6bff;background:#f4f7ff}",
    ".cd-v29-card.is-off{background:#f3f1ec;color:#8a847a;cursor:not-allowed}",
    ".cd-v29-badge{position:absolute;top:8px;right:8px;background:#2f6bff;color:#fff;border-radius:999px;font-size:10px;padding:2px 7px}",
    ".cd-v29-card.is-off .cd-v29-badge{background:#e7e2d8;color:#6d675f}",
    ".cd-v29-title{font-size:20px;font-weight:650;margin-top:2px}",
    ".cd-v29-price{font-size:18px;font-weight:650;margin:4px 0}",
    ".cd-v29-note{font-size:12px;color:#5c564e;margin:12px 0}",
    ".cd-v29-actions{display:flex;gap:8px}",
    ".cd-v29-go{flex:1;background:#2f6bff;color:#fff;border:0;border-radius:12px;min-height:46px;font-weight:650}",
    ".cd-v29-quiet-btn{border:1px solid #e4dfd6;background:#fff;border-radius:12px;min-height:46px;padding:0 16px}",
    ".cd-v29-panel{padding:16px;border:1px solid #e4dfd6;border-radius:14px;background:#fff}",
    ".cd-v29-panel h2{font-size:22px;margin:4px 0 8px}",
    ".cd-v29-reason{display:block;width:100%;text-align:left;margin:4px 0;padding:8px 10px;border-radius:8px;border:1px solid #e4dfd6;background:#fff}",
    ".cd-v29-reason.is-on{border-color:#2f6bff;background:#f4f7ff}",
    ".cd-v29-panel textarea,.cd-v29-panel input{width:100%;margin-top:6px;padding:8px;border:1px solid #e4dfd6;border-radius:8px}",
    ".cd-v29-stamp{margin-top:8px;font-weight:650}",
    ".cd-v29-dark,.cd-v29-dark .cd-v29-sheet,.cd-v29-dark .cd-v29-meter,.cd-v29-dark .cd-v29-panel{background:#1c1916;color:#f4efe6}",
    ".cd-v29-dark .cd-v29-card,.cd-v29-dark .cd-v29-reason,.cd-v29-dark .cd-v29-quiet-btn{background:#2a2622;color:#f4efe6;border-color:#3a342c}",
    ".cd-v29-dark .cd-v29-card.is-off{background:#241f1b;color:#a39b90}",
    ".cd-v29-dark .cd-v29-kicker,.cd-v29-dark .cd-v29-footer,.cd-v29-dark .cd-v29-note{color:#c8bfb2}",
  ].join("\n");

  function Style() {
    return React.createElement("style", null, css);
  }

  function Stamp(props) {
    return React.createElement("p", { className: "cd-v29-stamp" }, props.text || "Verified, In person, 2 years");
  }

  function RevealPicker(props) {
    var reasons = props.reasons || ["FINTRAC request", "report filing", "ID mismatch", "client request", "Other"];
    var selected = props.selected || "Other";
    return React.createElement("section", { className: "cd-v29-panel", "aria-label": "Reveal ID number" },
      React.createElement("div", { className: "cd-v29-kicker" }, "Staff only"),
      React.createElement("h2", null, "Reveal ID number"),
      reasons.map(function (reason) {
        var on = reason === selected;
        return React.createElement("button", {
          type: "button", key: reason,
          className: "cd-v29-reason" + (on ? " is-on" : ""),
          "aria-pressed": on ? "true" : "false",
          onClick: function () { if (props.onSelect) props.onSelect(reason); },
        }, reason);
      }),
      selected === "Other" ? React.createElement("label", null, "Note",
        React.createElement("textarea", { defaultValue: props.note || "Asked for their own record", "aria-label": "Other reason" })
      ) : null
    );
  }

  function OccupationRequired() {
    return React.createElement("section", { className: "cd-v29-panel", "aria-label": "Occupation required" },
      React.createElement("div", { className: "cd-v29-kicker" }, "CAD 3,000 or more"),
      React.createElement("h2", null, "Occupation is required"),
      React.createElement("p", null, "This exchange cannot post until you record an occupation. Client declined is not an answer."),
      React.createElement("div", null, ["Employed", "Self-employed", "Retired", "Student"].map(function (label) {
        return React.createElement("button", { type: "button", key: label, className: "cd-v29-reason" }, label);
      })),
      React.createElement("input", { "aria-label": "Occupation", placeholder: "Or type the occupation" })
    );
  }

  function LctrLeft() {
    return React.createElement("section", { className: "cd-v29-panel", "aria-label": "LCTR client left" },
      React.createElement("div", { className: "cd-v29-kicker" }, "Prepared only. Not filed"),
      React.createElement("h2", null, "Client already left"),
      React.createElement("p", null, "Cash in 24 hours reached CAD 10,000. ID was not checked at this shop. The gap is on the LCTR draft and the compliance review list.")
    );
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    ExchangeV29: {
      Meter: Meter, Chooser: Chooser, Style: Style, Stamp: Stamp,
      RevealPicker: RevealPicker, OccupationRequired: OccupationRequired, LctrLeft: LctrLeft,
      NO_EARLIER: NO_EARLIER, FOOTER: FOOTER,
    },
  });
})();
