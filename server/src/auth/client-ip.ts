/* Which address a sign-in guess is counted against.

   A valid IPv6 CF-Connecting-IP is the client. IPv6 /64 rotation is
   accepted for now and is a follow-up.

   Order:
   1. The socket is a published Cloudflare address, or the socket is a
      private address and the rightmost X-Forwarded-For hop is a
      published Cloudflare address. Then CF-Connecting-IP is the client
      when it is an IP, IPv4 or IPv6. A missing or invalid header counts
      the socket and warns, without the header value.
   2. Otherwise a private socket with an X-Forwarded-For hop counts the
      rightmost hop.
   3. Otherwise the socket is the client.

   Render's docs say the app sees the proxy IP, and that the first
   X-Forwarded-For entry is the client. This code does not use that
   first entry. The fallbacks stay safe whatever the header shape:
   CF-Connecting-IP is trusted only when the hop is actually Cloudflare,
   a caller-supplied header cannot open a new bucket unless that hop is
   Cloudflare, and a leftmost forged X-Forwarded-For entry is never the
   bucket. The first request logs the header names present, with no
   values and no IPs. Reading those names in the live log, right after
   merge, is how the header shape gets checked.

   Nothing here reads an environment variable. Loopback is not treated
   as a platform proxy. */
import { isIP } from "node:net";
import { isCloudflareIp } from "./cloudflare-ips.js";

/** A private (RFC1918) socket address. Loopback is not included:
    a test, and a process with nothing in front, is its own client. */
export function isPlatformProxy(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function normalizeIp(raw: string): string | undefined {
  let ip = raw.trim();
  if (!ip) return undefined;
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 1) ip = ip.slice(1, end);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  return ip || undefined;
}

function headerValue(headers: { [name: string]: unknown }, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.map(String).join(",");
  return typeof value === "string" ? value : "";
}

function forwardedHops(headers: { [name: string]: unknown }): string[] {
  return headerValue(headers, "x-forwarded-for")
    .split(",")
    .map((part) => normalizeIp(part))
    .filter((part): part is string => !!part);
}

function connectingIp(headers: { [name: string]: unknown }): string | undefined {
  const first = headerValue(headers, "cf-connecting-ip").split(",")[0];
  const ip = first ? normalizeIp(first) : undefined;
  if (!ip || isIP(ip) === 0) return undefined;
  return ip;
}

let notedHeaderNames = false;

/** Once, on the first counted request. Names only: no values, no addresses. */
function noteHeaderNames(headers: { [name: string]: unknown }): void {
  if (notedHeaderNames) return;
  notedHeaderNames = true;
  const names = Object.keys(headers).filter((name) => name !== "").sort();
  console.warn(`[signin] first request headers: ${names.length ? names.join(", ") : "(none)"}`);
}

export function clientIp(req: { ip?: string; headers: { [name: string]: unknown } }): string {
  noteHeaderNames(req.headers);
  const socket = req.ip ? normalizeIp(req.ip) : undefined;
  if (!socket) throw new Error("Sign-in has no client address to count.");
  const hops = forwardedHops(req.headers);
  const renderHop = hops.length > 0 ? hops[hops.length - 1] : undefined;
  const cloudflareHop = isCloudflareIp(socket)
    || (!!renderHop && isPlatformProxy(socket) && isCloudflareIp(renderHop));
  if (cloudflareHop) {
    const client = connectingIp(req.headers);
    if (client) return client;
    console.warn("[signin] CF-Connecting-IP is missing or not an IP. Counting the peer address.");
    return socket;
  }
  if (renderHop && isPlatformProxy(socket)) return renderHop;
  return socket;
}
