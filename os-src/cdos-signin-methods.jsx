/* Sign-in methods (CD-277). Passkey, Google, Microsoft, and states B to H.
   A and C show the email field and Continue with email. A2 opens the
   password under that field for every non-empty address, with no lookup.
   Drawn only when a sign-in flag is on. The preview gallery draws it
   with fake data and does not call the adapter. */
(function () {
  const { useEffect, useRef, useState } = React;
  const adapter = () => window.CDOS.signInAdapter;
  const NOT_READY = "This way in is not available yet.";
  const SAME_MISS = "That email or password does not match. Try again.";
  const SSO_MISS = "That sign-in didn't go through. Try again, or use email.";
  const SSO_SLOW = "Too many sign-in tries. Wait a few minutes and try again.";

  /* Module scope so a test can see that continuing with email does not
     call the network. Any non-empty address opens the password step. */
  function continueWithEmail(email) {
    const open = adapter().openPasswordStep(email);
    if (!open) return { ok: false, error: "Enter your email." };
    return { ok: true };
  }

  const CSS = `
.cd-si,.cd-set{box-sizing:border-box;--ink:#17140F;--paper:#F7F4ED;--white:#fff;--forest:#1D6B45;--graph:#45403A;--mute:#6E675E;--faint:#9C948A;--hair:#D9D2C4;--field:#CFC7B7;--soft:#E6F2EB;--warn-bg:#F5E8CF;--warn-text:#8A5A0E;--positive-text:#165A3A;--positive-bg:#E6F2EB;--ui:Archivo,system-ui,sans-serif;--serif:'Instrument Serif',Georgia,serif;--mono:'IBM Plex Mono',ui-monospace,monospace;color:var(--ink);font-family:var(--ui);-webkit-font-smoothing:antialiased}
.cd-si *,.cd-set *{box-sizing:border-box}
.cd-si button,.cd-si input{font:inherit;color:inherit}
.cd-si button{cursor:pointer}
.cd-si button:focus-visible,.cd-si a:focus-visible,.cd-si input:focus-visible{outline:2px solid var(--forest);outline-offset:2px}
.cd-si.is-desk{position:relative;width:1280px;height:800px;padding:0 64px;background:var(--paper)}
.cd-si.is-phone{position:relative;width:390px;min-height:844px;padding:0 20px;background:var(--paper)}
.cd-si header.top{height:88px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--hair)}
.cd-si.is-phone header.top{height:72px;gap:12px}
.cd-si .lockup{display:flex;align-items:center;height:44px;margin-left:-4px}
.cd-si.is-phone .lockup{height:36px;margin-left:-2px}
.cd-si .word{margin-left:10px;font-family:'Schibsted Grotesk',sans-serif;font-weight:800;font-size:15px;letter-spacing:.06em}
.cd-si.is-phone .word{margin-left:6px;font-size:13px}
.cd-si .word i{font-family:var(--mono);font-style:normal;font-weight:600;font-size:11px;letter-spacing:.08em;color:var(--forest);position:relative;top:-8px;margin-left:6px}
.cd-si .newhere{font-size:14px;color:var(--mute);background:none;border:0;padding:0}
.cd-si.is-phone .newhere{font-size:13px}
.cd-si .newhere b{color:var(--ink);font-weight:600}
.cd-si .newhere .arr{color:var(--forest);margin-left:4px}
.cd-si.is-phone .nh-prefix{display:none}
.cd-si .eyebrow{font-family:var(--mono);font-weight:500;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.cd-si .left{position:absolute;left:64px;top:160px;width:560px}
.cd-si h1.display{font-family:var(--serif);font-weight:400;font-size:140px;line-height:.86;letter-spacing:-0.025em;margin:20px 0 0;color:var(--ink)}
.cd-si h1.display em{font-style:italic}
.cd-si h1.display .dot{display:inline-block;width:22px;height:22px;border-radius:50%;background:var(--forest);margin-left:8px;vertical-align:baseline;transform-origin:center}
.cd-si .sub{margin-top:28px;font-size:18px;line-height:1.45;color:var(--graph);max-width:400px}
.cd-si .slot{position:absolute;height:1px;background:var(--ink);pointer-events:none;transform-origin:left center;transform:scaleX(0);display:none}
.cd-si .right{position:absolute;left:760px;top:160px;width:456px}
.cd-si footer.footline{position:absolute;left:64px;right:64px;bottom:0;height:56px;border-top:1px solid var(--hair);display:flex;align-items:center}
.cd-si footer.footline .line{font-family:var(--serif);font-style:italic;font-size:17px;color:var(--graph)}
.cd-si .btn{min-height:56px;height:56px;border-radius:12px;display:flex;align-items:center;padding:0 20px;font-size:16px;font-weight:600;gap:12px;width:100%;text-align:left;border:0;background:transparent}
.cd-si .btn.primary{background:var(--ink);color:var(--paper)}
.cd-si .btn.primary .lbl{flex:1}
.cd-si .tag{font-family:var(--mono);font-weight:500;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8FD3AE;border:1px solid rgba(143,211,174,.4);border-radius:999px;padding:5px 9px 4px}
.cd-si .row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.cd-si .row.stack{grid-template-columns:minmax(0,1fr)}
.cd-si .btn.sec{background:var(--white);border:1px solid var(--hair);color:var(--ink);justify-content:center;font-size:13.5px;box-shadow:0 1px 0 rgba(23,20,15,.04);gap:8px;padding:0 12px}
.cd-si .btn.sec.wide{width:100%;font-size:16px;padding:0 20px}
.cd-si .or{display:flex;align-items:center;gap:16px;margin:24px 0}
.cd-si .or i{flex:1;height:1px;background:var(--hair)}
.cd-si .or span{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:var(--mute);text-transform:uppercase}
.cd-si label.eyebrow{display:block;margin:0 0 8px}
.cd-si .field{height:56px;border-radius:12px;background:var(--white);border:1px solid var(--field);display:flex;align-items:center;padding:0 8px 0 18px}
.cd-si .field input{flex:1;border:0;background:transparent;font:inherit;font-size:16px;color:var(--ink);outline:none;width:100%;min-width:0}
.cd-si .field input::placeholder{color:var(--faint)}
.cd-si .field.focus,.cd-si .field:focus-within{border-color:var(--forest);box-shadow:0 0 0 1px var(--forest)}
.cd-si .eye{width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex:none;color:var(--graph);background:transparent;border:0;padding:0}
.cd-si .signin-inline{font-size:14px;font-weight:600;color:var(--ink);padding:0 14px;height:40px;display:flex;align-items:center;flex:none;border:0;border-left:1px solid var(--hair);margin-left:4px;background:transparent;cursor:pointer}
.cd-si .foot{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:16px;font-size:14px;text-align:left}
.cd-si .foot.recover{margin-top:24px}
.cd-si .foot button{display:inline;color:var(--ink);font-weight:600;background:none;border:0;border-bottom:1px solid var(--hair);padding:0 0 2px;cursor:pointer;font-size:14px;width:auto;max-width:max-content;text-align:left}
.cd-si .pw-reveal:not(.open) .pw-inner{padding-top:0}
.cd-si .email-continue,.cd-si .pw-reveal{display:grid;transition:grid-template-rows 240ms cubic-bezier(0.22,1,0.32,1),opacity 240ms cubic-bezier(0.22,1,0.32,1)}
.cd-si .email-continue{grid-template-rows:1fr;opacity:1}
.cd-si .email-continue.hide{grid-template-rows:0fr;opacity:0;pointer-events:none}
.cd-si .pw-reveal{grid-template-rows:0fr;opacity:0}
.cd-si .pw-reveal.open{grid-template-rows:1fr;opacity:1}
.cd-si .ec-inner,.cd-si .pw-inner{overflow:hidden;min-height:0;padding-top:16px}
.cd-si .muted{color:var(--mute);font-weight:400}
.cd-si .note{background:var(--white);border:1px solid var(--hair);border-radius:12px;padding:16px 18px;margin-bottom:12px;text-align:left}
.cd-si .note strong{display:block;font-size:16px;font-weight:650;margin:0 0 4px}
.cd-si .note p{font-size:14px;line-height:1.45;color:var(--graph);margin:0}
.cd-si .nowrap{white-space:nowrap}
.cd-si .step-title{font-family:var(--serif);font-weight:400;font-size:34px;line-height:1.08;letter-spacing:-.02em;margin:0 0 10px}
.cd-si .step-lead{font-size:15px;line-height:1.45;color:var(--graph);margin:0 0 20px}
.cd-si .who-line,.cd-si .signed-as{margin-top:16px;font-size:13px;color:var(--mute)}
.cd-si .who-line b,.cd-si .signed-as b{color:var(--ink);font-weight:600}
.cd-si .pinrow{display:flex;gap:8px;margin:4px 0 18px}
.cd-si .pinbox{width:48px;height:56px;border-radius:10px;border:1px solid var(--field);background:var(--white);display:flex;align-items:center;justify-content:center;padding:0}
.cd-si .pinbox input{width:100%;height:100%;border:0;background:transparent;text-align:center;font-family:var(--mono);font-size:20px;outline:none}
.cd-si .pinbox .dot{width:10px;height:10px;border-radius:50%;background:var(--ink)}
.cd-si .pinbox.on{border:2px solid var(--forest)}
.cd-si .shop-list{display:flex;flex-direction:column;gap:10px}
.cd-si .shop-card{background:var(--white);border:1px solid var(--hair);border-radius:14px;padding:16px 18px;display:flex;align-items:center;gap:14px;text-align:left;width:100%;min-height:72px}
.cd-si .shop-card .ico,.cd-si .meth .ico{width:40px;height:40px;border-radius:10px;background:var(--paper);border:1px solid var(--hair);display:grid;place-items:center;flex:none}
.cd-si .shop-card b{display:block;font-size:16px;font-weight:650}
.cd-si .shop-card small{display:block;margin-top:3px;font-size:13px;color:var(--graph)}
.cd-si .success-mark{width:48px;height:48px;border-radius:50%;background:var(--positive-bg);color:var(--positive-text);display:grid;place-items:center;margin:0 0 16px}
.cd-si .hold{margin-top:14px;font-size:14px;color:var(--flag,#8A5A0E)}
.cd-si .cancel-row{margin-top:16px}
.cd-si .linkish{color:var(--ink);font-weight:600;font-size:14px;background:none;border:0;border-bottom:1px solid var(--hair);padding:0 0 2px;cursor:pointer}
.cd-si .placeholder,.cd-set .placeholder{margin-top:14px;background:var(--warn-bg,#F5E8CF);border:1px solid #D9C08A;border-radius:12px;padding:14px 16px;color:var(--warn-text,#8A5A0E)}
.cd-si .placeholder .plab,.cd-set .placeholder .plab{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--warn-text,#8A5A0E);margin-bottom:4px}
.cd-si .placeholder p,.cd-set .placeholder p{font-size:13px;line-height:1.4;color:var(--warn-text,#8A5A0E);margin:0}
.cd-si.is-phone{height:844px;min-height:844px;overflow:hidden}
.cd-si.is-phone .left{position:relative;left:auto;top:auto;width:auto;padding:12px 0 0}
.cd-si.is-phone h1.display{font-size:56px;line-height:.9;margin-top:8px}
.cd-si.is-phone h1.display .dot{width:12px;height:12px;margin-left:6px}
.cd-si.is-phone .sub{margin-top:12px;font-size:16px;max-width:none}
.cd-si.is-phone .right{position:relative;left:auto;top:auto;width:auto;margin-top:16px;padding-bottom:64px}
.cd-si.is-phone .slot{display:none !important}
.cd-si.is-phone footer.footline{left:20px;right:20px;height:52px}
.cd-si.is-phone footer.footline .line{font-size:15px}
.cd-si.is-phone .row{grid-template-columns:1fr;gap:12px;margin-top:12px}
.cd-si.is-phone .or{margin:16px 0}
.cd-si.is-phone .btn{height:auto;min-height:56px;padding:12px 18px}
.cd-si.is-phone .step-title{font-size:32px}
.cd-si.is-phone .pinbox{flex:1;width:auto;max-width:48px}
.cd-si.is-still .slot{transform:scaleX(1);animation:none}
.cd-si.is-still .dot{animation:none}
.cd-si.is-still .email-continue,.cd-si.is-still .pw-reveal{transition:none}
@keyframes cdSlotDraw{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes cdDotOnce{0%{transform:scale(1)}40%{transform:scale(1.18)}100%{transform:scale(1)}}
.cd-si .slot.play{animation:cdSlotDraw 720ms cubic-bezier(0.22,1,0.32,1) 300ms forwards}
.cd-si .dot.play{animation:cdDotOnce 560ms cubic-bezier(0.22,1,0.32,1) 180ms both}
@media (prefers-reduced-motion: reduce){
  .cd-si .email-continue,.cd-si .pw-reveal{transition:none}
  .cd-si .slot,.cd-si .dot{animation:none !important}
  .cd-si .slot{transform:scaleX(1)}
}
.cd-set{width:1280px;height:800px;background:#F7F4ED;display:flex;flex-direction:column;color:#17140F;font-family:Archivo,system-ui,sans-serif}
.cd-set.is-phone{width:390px;height:844px}
.cd-set .bar{display:flex;align-items:center;gap:16px;padding:8px 20px;border-bottom:1px solid #D9D2C4}
.cd-set .lg{display:flex;align-items:center;gap:8px;font-weight:800;font-size:12.5px;letter-spacing:.04em}
.cd-set .lg i{font-family:'IBM Plex Mono',monospace;font-style:normal;font-weight:700;font-size:6.5px;color:#1D6B45;position:relative;top:-5px}
.cd-set .shop{padding-left:16px;border-left:1px solid #D9D2C4}
.cd-set .shop b{display:block;font-size:12.5px}
.cd-set .shop small{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6E675E}
.cd-set nav.apps{display:flex;gap:2px}
.cd-set nav.apps span{display:flex;align-items:center;height:34px;padding:0 12px;border-radius:9px;font-size:12.5px;color:#6E675E}
.cd-set nav.apps span.on{background:#fff;color:#17140F;border:1px solid #D9D2C4;font-weight:600}
.cd-set .me{display:flex;align-items:center;gap:9px;margin-left:auto;padding-left:16px;border-left:1px solid #D9D2C4}
.cd-set .me .a{width:28px;height:28px;border-radius:50%;background:#17140F;color:#F7F4ED;display:grid;place-items:center;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700}
.cd-set .me small{display:block;font-size:10.5px;color:#6E675E}
.cd-set .subnav{display:flex;gap:4px;padding:10px 28px 0;border-bottom:1px solid #D9D2C4}
.cd-set .subnav span{height:36px;padding:0 12px;display:flex;align-items:center;font-size:13px;font-weight:600;color:#6E675E;border-bottom:2px solid transparent}
.cd-set .subnav span.on{color:#17140F;border-bottom-color:#17140F}
.cd-set .body{flex:1;padding:28px 48px;overflow:hidden}
.cd-set h1{font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;margin:0 0 8px}
.cd-set .lead{font-size:15px;line-height:1.45;color:#45403A;margin:0 0 22px;max-width:640px}
.cd-set .methods{background:var(--white);border:1px solid var(--hair);border-radius:14px;max-width:760px;color:var(--ink)}
.cd-set .meth{display:grid;grid-template-columns:40px 1fr auto;gap:14px;align-items:center;padding:16px 18px;border-bottom:1px solid var(--hair)}
.cd-set .meth:last-child{border-bottom:0}
.cd-set .meth .ico{width:40px;height:40px;border-radius:10px;background:var(--paper);border:1px solid var(--hair);display:grid;place-items:center;color:var(--ink)}
.cd-set .meth .name{font-size:15px;font-weight:650;color:var(--ink)}
.cd-set .meth .meta{font-size:13px;color:var(--graph);margin-top:2px}
.cd-set .meth .act{margin-top:0;font-size:13px;font-weight:600;background:none;border:0;border-bottom:1px solid var(--hair);padding:0 0 1px;min-height:44px;cursor:pointer;color:var(--ink)}
.cd-set .meth .act:disabled{color:var(--mute);border-bottom-color:transparent;cursor:not-allowed}
.cd-set .meth .hint{grid-column:2;font-size:13px;line-height:1.4;color:var(--mute);margin-top:6px}
.cd-set .bft{display:flex;gap:24px;padding:0 28px;height:40px;align-items:center;border-top:1px solid #D9D2C4;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6E675E}
.cd-set.is-phone .desk-only,.cd-set.is-phone .subnav,.cd-set.is-phone .bft{display:none}
.cd-set.is-phone .body{padding:8px 16px 16px}
.cd-set.is-phone h1{font-size:32px}
.cd-set.is-phone .back{display:flex;align-items:center;min-height:44px;background:none;border:0;font-weight:600;font-size:15px;padding:0}
.cd-set.is-desk .back,.cd-set.is-desk .tabbar,.cd-set.is-phone-hide{display:none}
.cd-set .tabbar{display:flex;height:64px;border-top:1px solid #D9D2C4;padding:6px 8px 10px}
.cd-set .tabbar span{flex:1;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#6E675E}
.cd-set .tabbar span.on{color:#17140F}
html[data-cdtheme="dark"] .cd-si,html[data-cdtheme="dark"] .cd-set{--ink:#F3EEE4;--paper:#14120E;--white:#221F1A;--graph:#C9C1B4;--mute:#A39B90;--faint:#8A8278;--hair:#3A342C;--field:#4A433A;--soft:#1C3A2C;--warn-bg:#3A2E18;--warn-text:#E6C98A;--positive-text:#B7E4C7;--positive-bg:#163528;background:var(--paper);color:var(--ink)}
.cd-set.is-live{width:auto;height:auto;min-height:0;display:block;background:transparent;color:var(--ink)}
html[data-cdtheme="dark"] .cd-set.is-live{background:transparent}
.cd-set.is-live h2{font-family:Archivo,system-ui,sans-serif;font-size:22px;margin:0 0 8px;color:var(--ink)}
.cd-set.is-live .intro{color:var(--graph);font-size:14px;line-height:1.45;margin:0 0 16px}
.cd-set .owner-auth{margin-top:20px;color:var(--ink)}
.cd-set .owner-auth h3,.cd-set .panel h3{margin:0 0 8px;font-size:18px;color:var(--ink)}
.cd-set .owner-auth p,.cd-set .panel p{margin:0 0 12px;color:var(--graph);font-size:14px;line-height:1.45}
.cd-set .panel{padding:20px;margin-top:16px;border:1px solid var(--hair);border-radius:16px;background:var(--white);color:var(--ink)}
.cd-set .stack{margin:0 0 12px}
.cd-set .stack label,.cd-set .check{display:block;font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px}
.cd-set .check{display:flex;gap:8px;align-items:flex-start;font-weight:500;margin:12px 0}
.cd-set .stack input,.cd-set .panel input[type="password"],.cd-set .panel input[inputmode="numeric"]{display:block;width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid var(--field);background:var(--paper);color:var(--ink);font:inherit;font-size:16px}
.cd-set .stack input:disabled{opacity:.7}
.cd-set .panel p.field-error{margin:8px 0 0;font-size:14px;line-height:1.4;color:var(--warn-text)}
.cd-set .panel p.why{margin:8px 0 0;font-size:14px;line-height:1.4;color:var(--graph)}
.cd-set .actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.cd-set .btn{min-height:48px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 18px;font:inherit;font-size:15px;font-weight:600;border:0;cursor:pointer;color:var(--ink);background:transparent}
.cd-set .btn.primary{background:var(--ink);color:var(--paper)}
.cd-set .btn.sec{background:var(--white);border:1px solid var(--hair);color:var(--ink)}
.cd-set .btn:disabled{opacity:.55;cursor:not-allowed}
.cd-set .btn:focus-visible,.cd-set .panel input:focus-visible{outline:2px solid var(--forest);outline-offset:2px}
.cd-set .keyrow{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:0 0 16px}
.cd-set .setup-key{font-family:var(--mono);font-size:16px;letter-spacing:.04em;background:var(--paper);color:var(--ink);padding:10px 12px;border-radius:10px;border:1px solid var(--hair)}
.cd-set .setup-key span+span{margin-left:.55em}
.cd-set .codes{margin:0 0 12px;padding-left:1.2em;color:var(--ink)}
.cd-set .codes code{font-family:var(--mono);color:var(--ink)}
.cd-set .hold{margin-top:14px;font-size:14px;color:var(--warn-text)}
.cd-set .spin{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;flex:none;animation:cdSpin .7s linear infinite}
@keyframes cdSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.cd-set .spin{animation:none}}
.cd-si .staging{position:absolute;left:64px;bottom:64px;display:grid;gap:8px;width:280px}
.cd-si.is-phone .staging{position:relative;left:auto;bottom:auto;width:auto;margin:12px 0 24px}
`;

  function DeskMark({ h = 44 }) {
    const width = Math.round(h * (200 / 140));
    return (
      <svg className="mark" viewBox="0 0 200 140" width={width} height={h} aria-hidden="true">
        <circle cx="60" cy="70" r="48" fill="var(--ink)" />
        <path d="M116,22 H136 A48,48 0 0 1 136,118 H116 Z" fill="var(--ink)" />
        <rect x="60" y="64.5" width="92" height="11" fill="var(--paper)" />
        <circle cx="112" cy="70" r="6.5" fill="#1D6B45" />
      </svg>
    );
  }

  function IcoPasskey() {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" /><path d="M14 13.12c0 2.38 0 6.38-1 8.88" /><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" /><path d="M2 12a10 10 0 0 1 18-6" /><path d="M2 16h.01" /><path d="M21.8 16c.2-2 .131-5.354 0-6" /><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" /><path d="M8.65 22c.21-.66.45-1.32.57-2" /><path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
      </svg>
    );
  }
  function IcoGoogle() {
    return (
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
  function IcoMs() {
    return (
      <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
        <rect width="10" height="10" fill="#F25022" /><rect x="11" width="10" height="10" fill="#7FBA00" /><rect y="11" width="10" height="10" fill="#00A4EF" /><rect x="11" y="11" width="10" height="10" fill="#FFB900" />
      </svg>
    );
  }
  function IcoArrow() {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#17140F" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  }
  function IcoEye() {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#45403A" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>;
  }
  function IcoCheck() {
    return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#165A3A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l5 5 9-10" /></svg>;
  }
  function IcoShop() {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#17140F" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10l1.5-6h13L20 10M3 10h18v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2z" /><path d="M6 14v5h4v-5M14 14v5h4v-5" /></svg>;
  }
  function IcoMail() {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" /></svg>;
  }

  const SUBS = {
    a: "Sign in the way you set it up.",
    a2: "Sign in the way you set it up.",
    b: "Confirm on your device.",
    c: "Use another way to sign in.",
    d: "Owners and admins confirm this step.",
    e: "A shared counter still needs your PIN.",
    f: "Pick the shop you want to open.",
    g: "Optional, and you can change this later.",
    g2: "You are ready to open the desk.",
  };

  const PREVIEW_METHODS = [
    { id: "passkey", name: "Passkeys", meta: "None on this account", action: "Add", connected: false, icon: "passkey" },
    { id: "google", name: "Google", meta: "Not connected", action: "Connect", connected: false, icon: "google" },
    { id: "microsoft", name: "Microsoft", meta: "Not connected", action: "Connect", connected: false, icon: "microsoft" },
    { id: "email", name: "Email and password", meta: "jordan@yorkfx.ca", action: "Remove", connected: true, icon: "mail" },
  ];

  function useHairline(rootRef, device, motion, state) {
    useEffect(() => {
      const root = rootRef.current;
      if (!root) return undefined;
      let dead = false;
      const layout = (play) => {
        if (dead || !root.isConnected) return;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const still = reduce || motion !== "play" || !play;
        root.classList.toggle("is-still", still);
        const dot = root.querySelector("[data-cd-dot]");
        const slot = root.querySelector("[data-cd-slot]");
        const target = root.querySelector("[data-cd-target]");
        const left = root.querySelector("[data-cd-left]");
        const right = root.querySelector("[data-cd-right]");
        const nudgeClear = () => {
          if (!left || !right) return;
          const footerH = device === "390" ? 52 : 56;
          const viewH = device === "390" ? 844 : 800;
          const head = device === "390" ? 72 : 88;
          const rev = right.querySelector("#pw-reveal");
          const cont = right.querySelector("#email-continue");
          let fullH = right.getBoundingClientRect().height;
          if (rev) {
            const prevRev = rev.className;
            const prevCont = cont ? cont.className : "";
            rev.style.transition = "none";
            if (cont) cont.style.transition = "none";
            rev.classList.add("open");
            if (cont) cont.classList.add("hide");
            fullH = right.getBoundingClientRect().height;
            rev.className = prevRev;
            rev.style.transition = "";
            if (cont) { cont.className = prevCont; cont.style.transition = ""; }
          }
          const overflow = (right.getBoundingClientRect().top + fullH) - (viewH - footerH - 16);
          if (overflow <= 0) return;
          const shift = Math.min(overflow, Math.max(0, left.getBoundingClientRect().top - (head + 4)));
          if (shift <= 0) return;
          if (device === "390") {
            const cur = parseFloat(getComputedStyle(left).marginTop) || 0;
            left.style.marginTop = (cur - shift) + "px";
          } else {
            left.style.top = (parseFloat(left.style.top) - shift) + "px";
            right.style.top = (parseFloat(right.style.top) - shift) + "px";
          }
        };
        if (device === "390" || !dot || !slot || !left || !right) {
          if (slot) slot.style.display = "none";
          nudgeClear();
          if (dot && !still) {
            dot.classList.remove("play");
            void dot.offsetWidth;
            dot.classList.add("play");
          }
          root.setAttribute("data-ready", "1");
          return;
        }
        if (!target || state === "h") {
          slot.style.display = "none";
          root.setAttribute("data-ready", "1");
          return;
        }
        const headerH = 88;
        const band = 800 - headerH - 56;
        const lr = left.getBoundingClientRect();
        const rightBox = right.getBoundingClientRect();
        const core = right.querySelector("[data-cd-core]");
        const coreBox = core ? core.getBoundingClientRect() : rightBox;
        const dr = dot.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        const targetOffset = tr.top - rightBox.top;
        const dotC = dr.top + dr.height / 2 - lr.top;
        const rightRel = dotC - targetOffset - tr.height / 2;
        const topMost = Math.min(0, rightRel);
        const botMost = Math.max(lr.height, rightRel + coreBox.height);
        const total = botMost - topMost;
        const T = headerH + (band - total) / 2 - topMost;
        left.style.top = T + "px";
        right.style.top = (T + rightRel) + "px";
        const r2 = dot.getBoundingClientRect();
        const p2 = target.getBoundingClientRect();
        const gap = 20;
        if (p2.left > r2.right + gap) {
          slot.style.left = (r2.right + gap) + "px";
          slot.style.width = (p2.left - (r2.right + gap)) + "px";
          slot.style.top = (r2.top + r2.height / 2 - 0.5) + "px";
          slot.style.display = "block";
          slot.classList.remove("play");
          dot.classList.remove("play");
          void slot.offsetWidth;
          if (!still) {
            slot.classList.add("play");
            dot.classList.add("play");
          }
          nudgeClear();
          const r3 = dot.getBoundingClientRect();
          slot.style.top = (r3.top + r3.height / 2 - 0.5) + "px";
        } else {
          slot.style.display = "none";
          nudgeClear();
        }
        root.setAttribute("data-ready", "1");
      };
      const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      ready.then(() => { requestAnimationFrame(() => requestAnimationFrame(() => layout(true))); });
      window.startMotion = () => layout(true);
      return () => { dead = true; if (window.startMotion) delete window.startMotion; };
    }, [device, motion, state]);
  }

  function Providers({ flags, preview, onStub }) {
    const showG = preview || flags.google;
    const showM = preview || flags.microsoft;
    if (!showG && !showM) return null;
    return (
      <div className={showG && showM ? "row stack" : "row"}>
        {showG ? <button type="button" className="btn sec" onClick={() => onStub("continueWithGoogle")}><IcoGoogle /><span>Continue with Google</span></button> : null}
        {showM ? <button type="button" className="btn sec" onClick={() => onStub("continueWithMicrosoft")}><IcoMs /><span>Continue with Microsoft</span></button> : null}
      </div>
    );
  }

  function EmailCore({ email, setEmail }) {
    return (
      <>
        <div className="or" aria-hidden="true"><i /><span>or</span><i /></div>
        <label className="eyebrow" htmlFor="cd-email">Email or desk ID</label>
        <div className="field" id="email-field">
          <input id="cd-email" name="email" type="text" autoComplete="username" placeholder="you@shop.ca or desk ID" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </>
    );
  }

  function EmailAfter({ showPassword, password, setPassword, showPw, setShowPw, onLink, onRecover, notice }) {
    return (
      <>
        <div className={"email-continue" + (showPassword ? " hide" : "")} id="email-continue">
          <div className="ec-inner">
            <button type="submit" className="btn sec wide" id="email-go">Continue with email</button>
            <div className="foot"><button type="button" onClick={onLink}>Email me a sign-in link</button></div>
          </div>
        </div>
        <div className={"pw-reveal" + (showPassword ? " open" : "")} id="pw-reveal">
          <div className="pw-inner">
            <div className={"field" + (showPassword ? " focus" : "")} id="pw-field">
              <input id="pw-input" name="password" type={showPw ? "text" : "password"} autoComplete="current-password" placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!showPassword} tabIndex={showPassword ? 0 : -1} />
              <button type="button" className="eye" aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)} disabled={!showPassword} tabIndex={showPassword ? 0 : -1}><IcoEye /></button>
              <button type="submit" className="signin-inline" disabled={!showPassword} tabIndex={showPassword ? 0 : -1}>Sign in</button>
            </div>
            <div className="foot"><button type="button" onClick={onLink} tabIndex={showPassword ? 0 : -1}>Email me a link instead</button></div>
          </div>
        </div>
        <div className="foot recover"><span><span className="muted">Can't get in? </span><button type="button" onClick={onRecover}>Recover access</button></span></div>
        {notice ? <p className="hold" role="status">{notice}</p> : null}
      </>
    );
  }

  function MethodsList({ methods, onAction, busy = false }) {
    const blockedReason = "Add another way to sign in before removing this one.";
    return (
      <div className="methods">
        {methods.map((m) => {
          const blocked = m.action === "Remove" && adapter().removalBlocked(methods, m.id);
          return (
            <div className="meth" key={m.id}>
              <div className="ico">{m.icon === "google" ? <IcoGoogle /> : m.icon === "microsoft" ? <IcoMs /> : m.icon === "mail" ? <IcoMail /> : <IcoPasskey />}</div>
              <div>
                <div className="name">{m.name}</div>
                <div className="meta">{m.meta}</div>
                {blocked ? <div className="hint" id={"why-" + m.id}>{blockedReason}</div> : null}
              </div>
              {m.action ? <button type="button" className="act" disabled={blocked || busy} aria-describedby={blocked ? "why-" + m.id : undefined} onClick={() => onAction(m)}>{m.action}</button> : <span />}
            </div>
          );
        })}
      </div>
    );
  }

  function SettingsFrame({ device, notice, onAction }) {
    const phone = device === "390";
    return (
      <div className={"cd-set" + (phone ? " is-phone" : " is-desk")} data-cd-frame="h">
        <div className="bar">
          <span className="lg desk-only"><DeskMark h={22} />CURRENCYDESK<i>OS</i></span>
          <span className="shop"><b>York Currency Exchange</b><small>Main · Till 1</small></span>
          <nav className="apps desk-only" aria-label="Desk">
            <span>Counter</span><span>Deals</span><span>Clients</span><span>Till</span><span className="on">Settings</span>
          </nav>
          <span className="me desk-only"><span className="a">JH</span><span><b>J. Hale</b><small>Owner</small></span></span>
        </div>
        <div className="subnav"><span>Shop</span><span>ID checks</span><span>Staff</span><span className="on">Sign-in</span><span>Billing</span></div>
        <div className="body">
          {phone ? <button type="button" className="back">Settings</button> : null}
          <div className="eyebrow">Settings · Sign-in</div>
          <h1>Sign-in methods</h1>
          <p className="lead">Ways you can open the desk. The last remaining method stays until you add another.</p>
          <MethodsList methods={PREVIEW_METHODS} onAction={onAction} />
          <div className="placeholder"><div className="plab">Password rule pending Sol</div><p>The owner and admin password rule is not decided yet. This line is a placeholder.</p></div>
          {notice ? <p className="hold" role="status">{notice}</p> : null}
        </div>
        <div className="bft"><span>York Currency Exchange</span><span>J. Hale · Owner</span><span>18 Nov 2026 · 2:14 pm</span><span>Canada rules</span></div>
        <div className="tabbar" aria-hidden="true"><span>Rates</span><span>Ledger</span><span>Clients</span><span>Till</span><span className="on">More</span></div>
      </div>
    );
  }

  function SignInScreen(props) {
    const preview = props.preview === true;
    const flags = props.flags || { passkey: false, google: false, microsoft: false };
    const [state, setState] = useState(props.state || "a");
    const [email, setEmail] = useState(props.preview && props.state === "a2" ? "jordan@yorkfx.ca" : "");
    const [password, setPassword] = useState("");
    const [showPw, setShowPw] = useState(false);
    const [showPassword, setShowPassword] = useState(props.state === "a2");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [code, setCode] = useState("");
    const [shops, setShops] = useState([]);
    const [backup, setBackup] = useState(false);
    const [quick, setQuick] = useState(false);
    const authRef = useRef(null);
    const sending = useRef(false);
    const rootRef = useRef(null);
    const device = props.device === "390" || props.device === "1280"
      ? props.device
      : (typeof window !== "undefined" && window.innerWidth <= 500 ? "390" : "1280");
    const motion = props.motion || "still";
    useHairline(rootRef, device, motion, state);

    useEffect(() => {
      if (preview || typeof window === "undefined") return undefined;
      const q = new URLSearchParams(window.location.search);
      const sso = q.get("sso");
      if (sso === "refused") setNotice(SSO_MISS);
      if (sso === "slow") setNotice(SSO_SLOW);
      if (sso === "confirm") setState("d");
      if (sso === "shops") {
        setState("f");
        fetch("/api/auth/sso/shops", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d && Array.isArray(d.shops)) setShops(d.shops); })
          .catch(() => {});
      }
      return undefined;
    }, [preview]);

    useEffect(() => {
      if (preview) return undefined;
      let live = true;
      fetch("/api/staging/signin", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (live && d && d.enabled === true) setQuick(true); })
        .catch(() => {});
      return () => { live = false; };
    }, [preview]);

    useEffect(() => {
      if (props.state) {
        setState(props.state);
        setShowPassword(props.state === "a2");
        if (preview && props.state === "a2") setEmail("jordan@yorkfx.ca");
      }
    }, [props.state]);

    const onStub = async (name) => {
      if (preview) return;
      const fn = adapter().createSignInAdapter()[name];
      const result = fn ? await fn() : { status: "not_available" };
      if (!result || result.status === "not_available") setNotice(NOT_READY);
    };

    const onContinue = (e) => {
      e.preventDefault();
      const step = continueWithEmail(email);
      if (!step.ok) { setNotice(step.error); return; }
      setNotice("");
      setShowPassword(true);
    };

    const SRV2OS = { administrator: "Owner", branch_manager: "Manager", supervisor: "Senior teller", compliance_officer: "Manager", teller: "Cashier", auditor: "Trainee" };
    const adopt = (u) => {
      const dir = props.employees || [];
      const known = dir.find((person) => String(person.code || "").toLowerCase() === String(u.id).toLowerCase());
      return known || { id: "e_" + u.id, code: u.id, name: u.name || u.id, role: SRV2OS[u.role] || "Cashier", active: true, branches: [], home: null, _adopted: true };
    };

    const onSubmit = async (e) => {
      e.preventDefault();
      if (preview || sending.current) return;
      if (password.length < 1) { setNotice("Enter your password."); return; }
      sending.current = true;
      setBusy(true);
      setNotice("");
      try {
        const res = await fetch("/api/auth/login/start", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ staffId: email.trim().toLowerCase(), password }),
        });
        const data = await res.json().catch(() => null);
        sending.current = false;
        setBusy(false);
        if (res.status === 401 || !res.ok && res.status !== 429 && res.status !== 503) {
          setNotice(SAME_MISS);
          return;
        }
        if (!res.ok) { setNotice((data && data.detail) || "Sign-in is having trouble. Try again in a minute."); return; }
        const u = data && data.user;
        const rec = u ? adopt(u) : null;
        if (u && u.mustChangePassword && props.onMustChange) { props.onMustChange(rec, { current: password }, u.plan || null, u); return; }
        if (data && data.needsCode === false && props.onComplete) { props.onComplete(rec, (u && u.plan) || null, u); return; }
        authRef.current = { rec, u, staffId: email.trim().toLowerCase(), tenantId: u && u.tenantId };
        setCode("");
        setState("code");
      } catch (err) {
        sending.current = false;
        setBusy(false);
        setNotice("Sign-in is having trouble. Try again in a minute.");
      }
    };

    const onVerify = async (e) => {
      e.preventDefault();
      if (preview || code.length < 6) return;
      const a = authRef.current || {};
      setBusy(true);
      try {
        const res = await fetch("/api/auth/login/verify", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ staffId: a.staffId, tenantId: a.tenantId, code }),
        });
        const data = await res.json().catch(() => null);
        setBusy(false);
        if (!res.ok) { setNotice(SAME_MISS); setCode(""); return; }
        const u = (data && data.user) || a.u;
        if (props.onComplete) props.onComplete(a.rec, (u && u.plan) || null, u);
      } catch (err) {
        setBusy(false);
        setNotice("Sign-in is having trouble. Try again in a minute.");
      }
    };

    const showPasskey = preview || flags.passkey;
    const sub = SUBS[state] || SUBS.a;

    let right = null;
    if (state === "b") {
      right = (
        <div>
          <button type="button" className="btn primary" data-cd-target="1" aria-describedby="cd-wait"><IcoPasskey /><span className="lbl">Waiting for your device</span></button>
          <p id="cd-wait" className="step-lead" style={{ marginTop: 14 }} role="status" aria-live="polite">Confirm with your fingerprint, face or device unlock. This page will continue when you are done.</p>
          <div className="cancel-row"><button type="button" className="linkish" onClick={() => { if (!preview) setState("a"); }}>Cancel</button></div>
        </div>
      );
    } else if (state === "c") {
      right = (
        <form onSubmit={showPassword ? onSubmit : onContinue}>
          <div data-cd-core="1">
            <div className="note" data-cd-target="1"><strong>No passkey on this device</strong><p>Use Google, Microsoft, email or a sign-in link below.</p></div>
            <Providers flags={flags} preview={preview} onStub={onStub} />
            <EmailCore email={email} setEmail={setEmail} />
          </div>
          <EmailAfter showPassword={showPassword} password={password} setPassword={setPassword} showPw={showPw} setShowPw={setShowPw} onLink={() => onStub("sendSignInLink")} onRecover={() => props.onRecover && props.onRecover()} notice={notice} />
        </form>
      );
    } else if (state === "d") {
      const submitCode = async (e) => {
        e.preventDefault();
        if (preview) return;
        const value = (backup ? code : code).trim();
        if (value.length < 6) return;
        setBusy(true);
        try {
          const res = await fetch("/api/auth/sso/confirm", {
            method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
            body: JSON.stringify({ code: value }),
          });
          const data = await res.json().catch(() => null);
          setBusy(false);
          if (res.status === 429) { setNotice(SSO_SLOW); setCode(""); return; }
          if (!res.ok) { setNotice(SSO_MISS); setCode(""); return; }
          window.location.assign((data && data.returnTo) || "/app");
        } catch (err) {
          setBusy(false);
          setNotice("Sign-in is having trouble. Try again in a minute.");
        }
      };
      right = (
        <form onSubmit={submitCode}>
          <div className="eyebrow">Confirm it is you</div>
          <h2 className="step-title">Confirm it's you.</h2>
          <p className="step-lead">{showPasskey ? "Use a passkey or the 6-digit code from your authenticator app." : "Use the 6-digit code from your authenticator app."}</p>
          {showPasskey ? <button type="button" className="btn primary" data-cd-target="1" onClick={() => onStub("continueWithPasskey")}><IcoPasskey /><span className="lbl">Continue with a passkey</span></button> : null}
          <button type="button" className="btn sec wide" style={{ marginTop: 16 }} onClick={() => setBackup(false)}>Enter your 6-digit code</button>
          <div className="cancel-row"><button type="button" className="linkish" onClick={() => setBackup(true)}>Use a backup code</button></div>
          <div className="field" style={{ marginTop: 8 }}><input aria-label={backup ? "Backup code" : "Authenticator code"} autoComplete="one-time-code" placeholder={backup ? "Backup code" : "6-digit code"} value={code} onChange={(e) => setCode(e.target.value)} /></div>
          <button type="submit" className="btn primary" style={{ marginTop: 12 }} disabled={busy || code.trim().length < 6}><span className="lbl">Continue</span></button>
          {preview ? <p className="signed-as">Signed in with Google as <b>jordan@yorkfx.ca</b></p> : <p className="signed-as">This sign-in still needs your authenticator or a backup code.</p>}
          {notice ? <p className="hold" role="status">{notice}</p> : null}
        </form>
      );
    } else if (state === "e") {
      right = (
        <div>
          <div className="eyebrow">Shared counter</div>
          <h2 className="step-title">Enter your 6-digit PIN</h2>
          <p className="step-lead">Your passkey signed you in. This device is shared, so every teller still enters their own PIN.</p>
          <div className="pinrow" data-cd-target="1" aria-label="Till PIN">
            <div className="pinbox"><span className="dot" /></div>
            <div className="pinbox"><span className="dot" /></div>
            <div className="pinbox"><span className="dot" /></div>
            <div className="pinbox on" />
            <div className="pinbox" />
            <div className="pinbox" />
          </div>
          <button type="button" className="linkish">Cancel</button>
          <p className="who-line"><b>Daniel Osei</b> · Teller</p>
        </div>
      );
    } else if (state === "f") {
      right = (
        <div>
          <div className="eyebrow">Two shops</div>
          <h2 className="step-title">Choose a shop</h2>
          <p className="step-lead">This account is linked to 2 shops.</p>
          <div className="shop-list">
            {(preview ? [{ staffUserId: "york", name: "York Currency Exchange" }, { staffUserId: "harbour", name: "Harbourfront Desk" }] : shops).map((shop, index) => (
              <button type="button" className="shop-card" data-cd-target={index === 0 ? "1" : undefined} key={shop.staffUserId} onClick={async () => {
                if (preview) return;
                const res = await fetch("/api/auth/sso/pick", {
                  method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
                  body: JSON.stringify({ staffUserId: shop.staffUserId }),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok) { setNotice(SSO_MISS); return; }
                if (data && data.step === "confirm") { setState("d"); return; }
                window.location.assign((data && data.returnTo) || "/app");
              }}><span className="ico"><IcoShop /></span><span><b>{shop.name}</b></span></button>
            ))}
          </div>
        </div>
      );
    } else if (state === "g") {
      right = (
        <div>
          <div className="eyebrow">A passkey</div>
          <h2 className="step-title">Sign in faster next time</h2>
          <p className="step-lead">A passkey uses this device's fingerprint, face or unlock. You can still sign in with Google, Microsoft or email.</p>
          <button type="button" className="btn primary" data-cd-target="1" onClick={() => onStub("continueWithPasskey")}><IcoPasskey /><span className="lbl">Set up passkey</span></button>
          <div className="cancel-row"><button type="button" className="linkish">Not now</button></div>
        </div>
      );
    } else if (state === "g2") {
      right = (
        <div>
          <div className="success-mark" data-cd-target="1"><IcoCheck /></div>
          <div className="eyebrow">Ready</div>
          <h2 className="step-title">Passkey is ready</h2>
          <p className="step-lead">This device can open the desk next time. You can add or remove passkeys in Settings.</p>
          <button type="button" className="btn primary"><span className="lbl" style={{ textAlign: "center" }}>Continue to the desk</span></button>
        </div>
      );
    } else if (state === "code") {
      right = (
        <form onSubmit={onVerify}>
          <h2 className="step-title">Check your email</h2>
          <p className="step-lead">If this email can sign in, a 6-digit code is on its way.</p>
          <label className="eyebrow" htmlFor="cd-code">Code</label>
          <div className="field"><input id="cd-code" inputMode="numeric" autoComplete="one-time-code" aria-label="Email code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></div>
          <button type="submit" className="btn primary" disabled={busy || code.length < 6}><span className="lbl">Continue</span></button>
          {notice ? <p className="hold" role="status">{notice}</p> : null}
        </form>
      );
    } else {
      right = (
        <form onSubmit={showPassword ? onSubmit : onContinue}>
          <div data-cd-core="1">
            {showPasskey ? (
              <button type="button" className="btn primary" data-cd-target="1" onClick={() => onStub("continueWithPasskey")}>
                <IcoPasskey /><span className="lbl">Continue with a passkey</span><span className="tag">Recommended</span>
              </button>
            ) : null}
            <Providers flags={flags} preview={preview} onStub={onStub} />
            <EmailCore email={email} setEmail={setEmail} />
          </div>
          <EmailAfter showPassword={showPassword} password={password} setPassword={setPassword} showPw={showPw} setShowPw={setShowPw} onLink={() => onStub("sendSignInLink")} onRecover={() => props.onRecover && props.onRecover()} notice={notice} />
        </form>
      );
    }

    return (
      <div ref={rootRef} className={"cd-si " + (device === "390" ? "is-phone" : "is-desk")} data-cd-frame={state} data-preview={preview ? "1" : "0"}>
        <style>{CSS}</style>
        <link rel="stylesheet" href="/web/fonts/fonts.css" />
        <header className="top">
          <div className="lockup" aria-label="CurrencyDesk OS">
            <DeskMark h={device === "390" ? 36 : 44} />
            <span className="word">CURRENCYDESK<i>OS</i></span>
          </div>
          <button type="button" className="newhere" onClick={() => { if (!preview && props.onSignup) props.onSignup(); }}>
            <span className="nh-prefix">New here? </span><b>Create your desk<span className="arr">→</span></b>
          </button>
        </header>
        <section className="left" data-cd-left="1">
          <div className="eyebrow">Sign in</div>
          <h1 className="display">Open<br /><em>the</em> desk<span className="dot" data-cd-dot="1" /></h1>
          <p className="sub">{sub}</p>
        </section>
        <section className="right" data-cd-right="1">{right}</section>
        <div className="slot" data-cd-slot="1" />
        <footer className="footline"><span className="line">Every exchange, on the record.</span></footer>
        {quick && !preview ? (
          <div className="staging">
            {window.CDOS.stagingEnterButtons(true).map((b) => (
              <button key={b.role} type="button" className="btn sec" onClick={() => fetch("/api/staging/enter", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ role: b.role }) }).then((r) => r.json()).then((d) => { if (d && d.user && props.onComplete) props.onComplete(adopt(d.user), d.user.plan || null, d.user); })}>{b.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function SignInMethods(props) {
    return <SignInScreen {...props} preview={false} />;
  }

  function SignInPreview({ state, device, motion }) {
    const name = String(state || "a").toLowerCase();
    const [notice, setNotice] = useState("");
    if (name === "h") {
      return (
        <div data-ready="1">
          <style>{CSS}</style>
          <link rel="stylesheet" href="/web/fonts/fonts.css" />
          <SettingsFrame device={device === "390" ? "390" : "1280"} notice={notice} onAction={() => setNotice(NOT_READY)} />
        </div>
      );
    }
    const flags = { passkey: true, google: true, microsoft: true };
    return <SignInScreen preview flags={flags} state={name} device={device} motion={motion} />;
  }

  const RECOVERY_FILE = "currencydesk-recovery-codes.txt";
  const RECOVERY_LINE = "Each code works once. Keep this file somewhere safe.";

  function finishGap(enrollment, enrollCode, savedCodes) {
    if (!enrollment) return "";
    if (enrollment.recoveryOnly) return savedCodes ? "" : "Tick that you saved your recovery codes.";
    const codeOk = /^\d{6}$/.test(enrollCode);
    if (codeOk && savedCodes) return "";
    if (!codeOk && !savedCodes) return "Enter the 6 digit code and tick that you saved your recovery codes.";
    if (!codeOk) return "Enter the 6 digit code.";
    return "Tick that you saved your recovery codes.";
  }

  /* Groups of four are display only. Copy sends the raw key.
     No QR is drawn: package.json has no QR library, and the key stays on the page. */
  function groupedKey(secret) {
    return String(secret || "").replace(/\s/g, "").match(/.{1,4}/g) || [];
  }

  function SignInMethodsSettings({ owner = false }) {
    const [notice, setNotice] = useState("");
    const [fieldError, setFieldError] = useState(null);
    const [methods, setMethods] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [pending, setPending] = useState(null);
    const [password, setPassword] = useState("");
    const [totp, setTotp] = useState("");
    const [factorRequired, setFactorRequired] = useState(false);
    const [busy, setBusy] = useState(false);
    const [hasTotp, setHasTotp] = useState(false);
    const [hasPasskey, setHasPasskey] = useState(false);
    const [enrollment, setEnrollment] = useState(null);
    const [enrollCode, setEnrollCode] = useState("");
    const [savedCodes, setSavedCodes] = useState(false);
    const [success, setSuccess] = useState("");
    const [copiedKey, setCopiedKey] = useState(false);
    const [copiedCodes, setCopiedCodes] = useState(false);
    const [downloaded, setDownloaded] = useState(false);
    const sending = useRef(false);
    const live = useRef(true);
    const request = useRef(null);
    const attempt = useRef(0);
    const blobUrl = useRef("");
    useEffect(() => {
      live.current = true;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 30_000);
      fetch("/api/auth/methods", { credentials: "same-origin", signal: controller.signal })
        .then((r) => { if (!r.ok) throw new Error("methods_unavailable"); return r.json(); })
        .then((d) => {
          if (!live.current) return;
          if (!d || !Array.isArray(d.methods)) throw new Error("methods_unavailable");
          setLoaded(true);
          setHasTotp(d.methods.some((m) => m.id === "totp" && m.connected));
          setHasPasskey(d.methods.some((m) => m.id === "passkey" && m.connected));
          setMethods(d.methods.filter((m) => m.id === "password" || m.id === "google" || m.id === "microsoft").map((m) => ({
            id: m.id,
            name: m.name,
            meta: m.connected ? "Connected" : "Not connected",
            connected: m.connected,
            action: m.id === "password" ? "" : (m.connected ? "Remove" : "Connect"),
            icon: m.id === "google" ? "google" : m.id === "microsoft" ? "microsoft" : "mail",
          })));
        })
        .catch(() => { if (live.current) setNotice("Sign-in methods could not load. Reload to try again."); })
        .finally(() => clearTimeout(deadline));
      return () => {
        live.current = false;
        attempt.current += 1;
        controller.abort();
        if (request.current) request.current.abort();
        if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = ""; }
      };
    }, []);
    const clearConfirmation = () => {
      setPending(null);
      setPassword("");
      setTotp("");
      setFactorRequired(false);
      setEnrollment(null);
      setEnrollCode("");
      setSavedCodes(false);
      setFieldError(null);
      setCopiedKey(false);
      setCopiedCodes(false);
      setDownloaded(false);
    };
    const cancelPending = () => {
      attempt.current += 1;
      const active = request.current;
      request.current = null;
      sending.current = false;
      if (active) active.abort();
      setBusy(false);
      clearConfirmation();
      setNotice("");
    };
    const onAction = (method) => {
      if (!method.action || !loaded || sending.current) return;
      if (method.action === "Remove" && adapter().removalBlocked(methods, method.id)) return;
      if (method.action === "Connect") {
        if (owner && !hasTotp && !hasPasskey) {
          setNotice("Set up your authenticator and recovery codes before connecting Google or Microsoft.");
          return;
        }
        const flags = adapter().flagsFromWindow(window);
        if ((method.id === "google" && !flags.google) || (method.id === "microsoft" && !flags.microsoft)) {
          setNotice(NOT_READY);
          return;
        }
      }
      clearConfirmation();
      setNotice("");
      setSuccess("");
      setPending(method);
    };
    const miss = (field, text) => {
      setFieldError({ field, text });
      setPassword("");
      setTotp("");
    };
    const confirm = async (event, usePasskey = false) => {
      event.preventDefault();
      if (!pending || (!usePasskey && !password) || sending.current) return;
      const id = ++attempt.current;
      sending.current = true;
      setBusy(true);
      setNotice("");
      setFieldError(null);
      const controller = new AbortController();
      request.current = controller;
      const current = () => live.current && id === attempt.current;
      // One deadline covers confirmation, body parsing and optional removal.
      // These requests do not create a new sign-in session.
      const deadline = setTimeout(() => controller.abort(), 30_000);
      try {
        let proof = { password, ...(totp ? { totp } : {}) };
        if (usePasskey) {
          if (!window.PublicKeyCredential || typeof PublicKeyCredential.parseRequestOptionsFromJSON !== "function") {
            setNotice("This browser cannot confirm with a passkey. Update it, or use your password and authenticator.");
            return;
          }
          const options = await fetch("/api/auth/stepup/passkey/options", {
            method: "POST", credentials: "same-origin", signal: controller.signal,
          });
          if (!options.ok) throw new Error("passkey_not_available");
          const body = await options.json();
          if (!current()) return;
          if (controller.signal.aborted) throw new Error("request_expired");
          const credential = await navigator.credentials.get({
            publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(body), signal: controller.signal,
          });
          if (!current()) return;
          if (controller.signal.aborted || !credential) throw new Error("passkey_cancelled");
          proof = credential.toJSON();
        }
        const res = await fetch(usePasskey ? "/api/auth/stepup/passkey/verify" : "/api/auth/stepup", {
          method: "POST", credentials: "same-origin", signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof),
        });
        const data = await res.json().catch(() => null);
        if (!current()) return;
        if (controller.signal.aborted) throw new Error("request_expired");
        if (res.status === 403 && data && data.error === "factor_required") {
          setFactorRequired(true);
          setTotp("");
          setFieldError({ field: "totp", text: "Enter the code from your authenticator app to continue." });
          return;
        }
        if (!res.ok || !data || data.ok !== true) {
          miss(factorRequired ? "totp" : "password", res.status === 429 ? "Too many tries. Wait before trying again." : "We could not confirm it's you. Check your details and try again.");
          return;
        }
        setPassword("");
        setTotp("");
        if (pending.id === "totp") {
          const setup = await fetch("/api/auth/mfa/" + (hasTotp ? "recovery" : "enroll/start"), {
            method: "POST", credentials: "same-origin", signal: controller.signal,
          });
          const body = await setup.json().catch(() => null);
          if (!current()) return;
          if (controller.signal.aborted) throw new Error("request_expired");
          if (!setup.ok || !body || body.ok !== true || !Array.isArray(body.backupCodes) || !body.backupCodes.length ||
              !body.backupCodes.every((c) => typeof c === "string") ||
              (!hasTotp && (typeof body.ticket !== "string" || typeof body.manualSecret !== "string"))) {
            setFieldError({ field: "password", text: "Authenticator setup could not finish. Confirm again to retry." });
            return;
          }
          setEnrollment({ ticket: body.ticket, secret: body.manualSecret, codes: body.backupCodes, recoveryOnly: hasTotp });
          return;
        }
        if (pending.action === "Connect") {
          window.location.assign("/api/auth/sso/link/" + pending.id + "/start");
          return;
        }
        const removed = await fetch("/api/auth/sso/" + pending.id + "/unlink", {
          method: "POST", credentials: "same-origin", signal: controller.signal,
        });
        if (!current()) return;
        if (controller.signal.aborted) throw new Error("request_expired");
        if (removed.status === 409) { setNotice("Add another way to sign in before removing this one."); return; }
        if (!removed.ok) { setNotice("The method could not be removed. Confirm again to retry."); return; }
        window.location.assign("/login");
      } catch {
        if (!current()) return;
        setPassword("");
        setTotp("");
        setEnrollCode("");
        setFieldError({ field: "password", text: "The request could not finish. Check your connection and confirm again." });
      } finally {
        clearTimeout(deadline);
        if (request.current === controller) request.current = null;
        if (id === attempt.current) {
          sending.current = false;
          if (live.current) setBusy(false);
        }
      }
    };
    const copyValue = async (text, which) => {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
        await navigator.clipboard.writeText(text);
        if (!live.current) return;
        if (which === "key") setCopiedKey(true);
        else setCopiedCodes(true);
      } catch { /* A failed copy stays on Copy. The codes are not logged. */ }
    };
    const downloadCodes = () => {
      if (!enrollment || !enrollment.codes || !enrollment.codes.length) return;
      let url = "";
      let link = null;
      try {
        const date = new Date().toISOString().slice(0, 10);
        const text = enrollment.codes.join("\n") + "\n" + date + "\n" + RECOVERY_LINE + "\n";
        url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        blobUrl.current = url;
        link = document.createElement("a");
        link.href = url;
        link.download = RECOVERY_FILE;
        document.body.appendChild(link);
        link.click();
        if (live.current) setDownloaded(true);
      } catch {
        if (live.current) setDownloaded(false);
      } finally {
        if (link && link.parentNode) link.remove();
        if (url) URL.revokeObjectURL(url);
        if (blobUrl.current === url) blobUrl.current = "";
      }
    };
    const finishEnrollment = async (event) => {
      event.preventDefault();
      if (sending.current || !enrollment || !savedCodes) return;
      if (enrollment.recoveryOnly) {
        clearConfirmation();
        setSuccess("Recovery codes replaced. Keep the new codes somewhere safe.");
        return;
      }
      if (!/^\d{6}$/.test(enrollCode)) return;
      const id = ++attempt.current;
      sending.current = true;
      setBusy(true);
      setNotice("");
      setFieldError(null);
      const controller = new AbortController();
      request.current = controller;
      const current = () => live.current && id === attempt.current;
      const deadline = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch("/api/auth/mfa/enroll/confirm", {
          method: "POST", credentials: "same-origin", signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: enrollment.ticket, code: enrollCode }),
        });
        const body = await res.json().catch(() => null);
        if (!current()) return;
        if (controller.signal.aborted) throw new Error("request_expired");
        setEnrollCode("");
        if (!res.ok || !body || body.ok !== true) {
          setFieldError({ field: "enroll", text: res.status === 429 ? "Too many tries. Wait before trying again." : "Setup could not be confirmed. Use a fresh authenticator code or cancel and start again." });
          return;
        }
        setHasTotp(true);
        clearConfirmation();
        setSuccess("Authenticator connected. You can now connect Google or Microsoft and use your authenticator when signing in.");
      } catch {
        if (!current()) return;
        setEnrollCode("");
        setFieldError({ field: "enroll", text: "Setup could not be confirmed. Check your connection. Reload to check whether it completed before starting again." });
      } finally {
        clearTimeout(deadline);
        if (request.current === controller) request.current = null;
        if (id === attempt.current) {
          sending.current = false;
          if (live.current) setBusy(false);
        }
      }
    };
    const reason = finishGap(enrollment, enrollCode, savedCodes);
    const rawKey = enrollment && !enrollment.recoveryOnly ? String(enrollment.secret || "").replace(/\s/g, "") : "";
    return (
      <div className="cd-set is-live">
        <style>{CSS}</style>
        <h2>Sign-in methods</h2>
        <p className="intro">Ways you can open the desk. The last remaining method stays until you add another.</p>
        <MethodsList methods={methods} onAction={onAction} busy={busy} />
        {owner ? <section className="owner-auth" aria-label="Owner sign-in protection">
          <h3>Authenticator and recovery codes</h3>
          <p>Owners need an authenticator and unused recovery codes to sign in with Google or Microsoft. Keep your password as a way back in.</p>
          <button type="button" className="btn primary" disabled={busy || !loaded} onClick={() => onAction({ id: "totp", name: "your authenticator", action: "Set up" })}>{hasTotp ? "Replace recovery codes" : "Set up authenticator"}</button>
        </section> : null}
        {pending && !enrollment ? <form onSubmit={confirm} aria-label="Confirm sign-in method change" aria-busy={busy ? "true" : "false"} className="panel">
          <h3>Confirm it's you</h3>
          <p>Confirm before you {pending.action === "Connect" ? "connect" : pending.action === "Remove" ? "remove" : "set up"} {pending.name}.</p>
          <div className="stack">
            <label htmlFor="signin-password">Password</label>
            <input id="signin-password" autoFocus type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} required aria-invalid={fieldError && fieldError.field === "password" ? "true" : undefined} aria-describedby={fieldError && fieldError.field === "password" ? "signin-password-error" : undefined} />
            {fieldError && fieldError.field === "password" ? <p id="signin-password-error" className="field-error" role="alert">{fieldError.text}</p> : null}
          </div>
          {factorRequired ? <div className="stack">
            <label htmlFor="signin-totp">Authenticator code</label>
            <input id="signin-totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={totp} disabled={busy} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} required aria-invalid={fieldError && fieldError.field === "totp" ? "true" : undefined} aria-describedby={fieldError && fieldError.field === "totp" ? "signin-totp-error" : undefined} />
            {fieldError && fieldError.field === "totp" ? <p id="signin-totp-error" className="field-error" role="alert">{fieldError.text}</p> : null}
          </div> : null}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy}>{busy ? <span className="spin" aria-hidden="true" /> : null}{busy ? "Confirming" : "Confirm and continue"}</button>
            {hasPasskey ? <button type="button" className="btn sec" disabled={busy} onClick={(e) => confirm(e, true)}>Confirm with passkey</button> : null}
            <button type="button" className="btn sec" onClick={cancelPending}>Cancel</button>
          </div>
        </form> : null}
        {enrollment ? <form onSubmit={finishEnrollment} aria-label="Authenticator setup" aria-busy={busy ? "true" : "false"} className="panel">
          <h3>{enrollment.recoveryOnly ? "Save your new recovery codes" : "Set up your authenticator"}</h3>
          {enrollment.recoveryOnly ? <p>Your previous recovery codes no longer work.</p> : <>
            <p>Add an account in your authenticator app using this setup key. Choose a time-based, six-digit code.</p>
            <div className="keyrow">
              <code className="setup-key">{groupedKey(rawKey).map((group, i) => <span key={i}>{group}</span>)}</code>
              <button type="button" className="btn sec" onClick={() => copyValue(rawKey, "key")}>{copiedKey ? "Copied" : "Copy"}</button>
            </div>
            <div className="stack">
              <label htmlFor="signin-enroll-code">New authenticator code</label>
              <input id="signin-enroll-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={enrollCode} disabled={busy} onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ""))} required aria-invalid={fieldError && fieldError.field === "enroll" ? "true" : undefined} aria-describedby={fieldError && fieldError.field === "enroll" ? "signin-enroll-error" : undefined} />
              {fieldError && fieldError.field === "enroll" ? <p id="signin-enroll-error" className="field-error" role="alert">{fieldError.text}</p> : null}
            </div>
          </>}
          <p>Save these recovery codes privately. Each works once. They will disappear when you leave this screen.</p>
          <ul className="codes">{enrollment.codes.map((code) => <li key={code}><code>{code}</code></li>)}</ul>
          <div className="actions">
            <button type="button" className="btn sec" onClick={() => copyValue(enrollment.codes.join("\n"), "codes")}>{copiedCodes ? "Copied" : "Copy all"}</button>
            <button type="button" className="btn sec" onClick={downloadCodes}>{downloaded ? "Downloaded" : "Download"}</button>
          </div>
          <label className="check"><input type="checkbox" checked={savedCodes} disabled={busy} onChange={(e) => setSavedCodes(e.target.checked)} /> I saved these recovery codes</label>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !!reason} aria-describedby={reason ? "finish-reason" : undefined}>{enrollment.recoveryOnly ? "Done" : "Finish setup"}</button>
            {!enrollment.recoveryOnly ? <button type="button" className="btn sec" onClick={cancelPending}>Cancel</button> : null}
          </div>
          {reason ? <p id="finish-reason" className="why">{reason}</p> : null}
        </form> : null}
        <div className="placeholder"><div className="plab">Password rule pending Sol</div><p>The owner and admin password rule is not decided yet. This line is a placeholder.</p></div>
        {notice ? <p className="hold" role="alert">{notice}</p> : null}
        {success ? <p role="status">{success}</p> : null}
      </div>
    );
  }

  window.CDOS = window.CDOS || {};
  window.CDOS.continueWithEmail = continueWithEmail;
  window.CDOS.SignInMethods = SignInMethods;
  window.CDOS.SignInPreview = SignInPreview;
  window.CDOS.SignInMethodsSettings = SignInMethodsSettings;
})();
