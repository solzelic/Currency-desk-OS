/* Which address a sign-in guess is counted against.

   Live desks are Cloudflare, then Render. The rightmost X-Forwarded-For
   hop on that path is a Cloudflare edge address: one address for every
   customer at a location, and a guesser who rotates the header walks
   out from under the limit.

   CF-Connecting-IP is the client only when the hop that delivered the
   request is in Cloudflare's published ranges. Otherwise the Render hop
   (the rightmost forwarded address, and only when our socket is the
   platform proxy) is the client. With no proxy in front, the socket is
   the client. A header the caller typed does not open a new bucket.

   Nothing here reads an environment variable. Render's proxy is the
   private address that connects to the process, which is already how
   the platform is wired. */
import { isCloudflareIp } from "./cloudflare-ips.js";

/** Render connects to the process from a private address. Loopback is
    not that proxy: a test, and a process with nothing in front, is its
    own client. */
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
  return first ? normalizeIp(first) : undefined;
}

export function clientIp(req: { ip?: string; headers: { [name: string]: unknown } }): string {
  const socket = req.ip ? normalizeIp(req.ip) : undefined;
  if (!socket) throw new Error("Sign-in has no client address to count.");
  const hops = forwardedHops(req.headers);
  const renderHop = hops.length > 0 ? hops[hops.length - 1] : undefined;
  const cloudflareHop = isCloudflareIp(socket)
    || (!!renderHop && isPlatformProxy(socket) && isCloudflareIp(renderHop));
  if (cloudflareHop) {
    const client = connectingIp(req.headers);
    if (!client) throw new Error("Cloudflare hop did not name a client address.");
    return client;
  }
  if (renderHop && isPlatformProxy(socket)) return renderHop;
  return socket;
}
