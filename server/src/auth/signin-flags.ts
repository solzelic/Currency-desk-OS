/* Sign-in method switches. Off unless the environment says on.
   Unset, empty, 0, false, no, and off all stay off. Nothing here
   opens a provider, a session, or a route. */

const ON = /^(1|true|yes|on)$/i;

export type SignInFlags = {
  passkey: boolean;
  google: boolean;
  microsoft: boolean;
};

export function readSignInFlags(env: NodeJS.ProcessEnv = process.env): SignInFlags {
  const on = (raw: string | undefined) => ON.test(String(raw ?? "").trim());
  return {
    passkey: on(env.SIGNIN_PASSKEY),
    google: on(env.SIGNIN_GOOGLE),
    microsoft: on(env.SIGNIN_MICROSOFT),
  };
}

export function anySignInFlag(flags: SignInFlags): boolean {
  return flags.passkey || flags.google || flags.microsoft;
}

/* Injected into the desk shell only when a flag is on. When every
   flag is off the shell is sent unchanged, so the page makes no
   new request to learn that. */
export function signInFlagScript(flags: SignInFlags): string {
  const body = JSON.stringify({
    passkey: flags.passkey === true,
    google: flags.google === true,
    microsoft: flags.microsoft === true,
  });
  return `<script>window.CDOS=window.CDOS||{};window.CDOS.signInFlags=${body};</script>`;
}

export function withSignInFlags(html: string, flags: SignInFlags = readSignInFlags()): string {
  if (!anySignInFlag(flags)) return html;
  const tag = signInFlagScript(flags);
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : tag + html;
}
