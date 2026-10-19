/* Cloudflare's published address ranges.

   Source: https://www.cloudflare.com/ips-v4
           https://www.cloudflare.com/ips-v6
   Fetched 2026-10-12.

   A hop in one of these ranges is Cloudflare. CF-Connecting-IP is the
   client only then. Any other hop is not allowed to name the client by
   that header — a caller can type it. Replace the lists when Cloudflare
   publishes a change. Do not edit a range to make a test pass. */
export const CLOUDFLARE_IPS_V4_SOURCE = "https://www.cloudflare.com/ips-v4";
export const CLOUDFLARE_IPS_V6_SOURCE = "https://www.cloudflare.com/ips-v6";
export const CLOUDFLARE_IPS_FETCHED = "2026-10-12";

export const CLOUDFLARE_IPV4: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

export const CLOUDFLARE_IPV6: readonly string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const baseInt = base ? ipv4ToInt(base) : null;
  if (ipInt == null || baseInt == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/* Eight groups, `::` standing for the missing zeros. Cloudflare's ranges
   do not use a dotted IPv4 tail, and neither does a hop we compare. */
function ipv6Bytes(ip: string): Uint8Array | null {
  const lower = ip.toLowerCase();
  if (lower.includes(".")) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(group) && group !== "0" && group !== "") return null;
    if (group !== "" && !/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = group === "" ? 0 : Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[(i * 2) + 1] = value & 0xff;
  }
  return bytes;
}

function inCidrV6(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipBytes = ipv6Bytes(ip);
  const baseBytes = base ? ipv6Bytes(base) : null;
  if (!ipBytes || !baseBytes || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  let left = bits;
  for (let i = 0; i < 16 && left > 0; i++) {
    const take = Math.min(8, left);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ipBytes[i]! & mask) !== (baseBytes[i]! & mask)) return false;
    left -= take;
  }
  return true;
}

export function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) return CLOUDFLARE_IPV6.some((cidr) => inCidrV6(ip, cidr));
  return CLOUDFLARE_IPV4.some((cidr) => inCidrV4(ip, cidr));
}
