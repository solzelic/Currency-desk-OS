/* Receipt options for one desk. Owner writes. Any signed-in teller reads,
   because the teller is the person who prints. */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { receiptClosing } from "./closing.js";

export interface ReceiptWho {
  id: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
}

export const PAPERS = ["80mm", "58mm", "a4", "letter"] as const;
export type Paper = (typeof PAPERS)[number];

export interface ReceiptOptions {
  header: string;
  footer: string;
  disclaimer: string;
  showRate: boolean;
  showFees: boolean;
  showClientName: boolean;
  showQr: boolean;
  showLogo: boolean;
  showMsb: boolean;
  paper: Paper;
  autoPrint: boolean;
  offerEmail: boolean;
  logo: string | null;
}

export const RECEIPT_DEFAULTS: ReceiptOptions = {
  header: "",
  footer: "",
  disclaimer: "",
  showRate: true,
  showFees: true,
  showClientName: true,
  showQr: true,
  showLogo: true,
  showMsb: true,
  paper: "80mm",
  autoPrint: false,
  offerEmail: false,
  logo: null,
};

const LOGO_RE = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const LOGO_MAX = 700 * 1024;

export function parseLogo(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Logo must be an image file.");
  const trimmed = value.trim();
  if (!LOGO_RE.test(trimmed)) throw new Error("Logo must be a PNG, JPEG, WEBP, or GIF image.");
  if (trimmed.length > Math.ceil(LOGO_MAX * 1.4)) throw new Error("Logo must be under 700KB.");
  return trimmed;
}

const patchBody = z.object({
  header: z.string().max(160).optional(),
  footer: z.string().max(240).optional(),
  disclaimer: z.string().max(500).optional(),
  showRate: z.boolean().optional(),
  showFees: z.boolean().optional(),
  showClientName: z.boolean().optional(),
  showQr: z.boolean().optional(),
  showLogo: z.boolean().optional(),
  showMsb: z.boolean().optional(),
  paper: z.enum(PAPERS).optional(),
  autoPrint: z.boolean().optional(),
  offerEmail: z.boolean().optional(),
  logo: z.string().nullable().optional(),
}).strict();

export function parseReceiptPatch(body: unknown): Partial<ReceiptOptions> {
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Check the receipt settings.");
  }
  const next: Partial<ReceiptOptions> = { ...parsed.data };
  if ("logo" in parsed.data) next.logo = parseLogo(parsed.data.logo);
  return next;
}

export function normalizeReceiptOptions(raw: unknown): ReceiptOptions {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const paper = PAPERS.includes(src.paper as Paper) ? src.paper as Paper : RECEIPT_DEFAULTS.paper;
  let logo: string | null = null;
  try { logo = parseLogo(src.logo); } catch { logo = null; }
  return {
    header: typeof src.header === "string" ? src.header.slice(0, 160) : "",
    footer: typeof src.footer === "string" ? src.footer.slice(0, 240) : "",
    disclaimer: typeof src.disclaimer === "string" ? src.disclaimer.slice(0, 500) : "",
    showRate: src.showRate !== false,
    showFees: src.showFees !== false,
    showClientName: src.showClientName !== false,
    showQr: src.showQr !== false,
    showLogo: src.showLogo !== false,
    showMsb: src.showMsb !== false,
    paper,
    autoPrint: src.autoPrint === true,
    offerEmail: src.offerEmail === true,
    logo,
  };
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export interface ReceiptIdentity {
  shopName: string;
  address: string | null;
  phone: string | null;
  licence: string | null;
  cdId: string | null;
  rateUrl: string | null;
  timezone: string;
  language: { code: "en"; label: "English" };
  shopEmail: string | null;
}

export async function loadReceiptIdentity(db: Db, user: ReceiptWho, origin: string): Promise<ReceiptIdentity> {
  const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, user.tenantId)).limit(1);
  const [entity] = await db.select().from(schema.legalEntities).where(eq(schema.legalEntities.id, user.legalEntityId)).limit(1);
  const [branch] = await db.select().from(schema.branches).where(eq(schema.branches.id, user.branchId)).limit(1);
  const [staff] = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, user.id)).limit(1);
  const cfg = tenant?.siteConfig ?? {};
  const setup = (tenant?.setup ?? {}) as Record<string, unknown>;
  const address = [
    text(cfg.address) ?? text(setup.address),
    text(cfg.city) ?? text(setup.city),
    text(cfg.region) ?? text(setup.region),
    text(cfg.postal) ?? text(setup.postal),
  ].filter((part): part is string => !!part).join(", ") || null;
  const shopEmail = text(cfg.email) ?? text(setup.email);
  const slug = text(tenant?.siteSlug);
  return {
    shopName: text(entity?.name) ?? text(tenant?.name) ?? "CurrencyDesk",
    address,
    phone: text(cfg.phone) ?? text(setup.phone),
    licence: text(entity?.msbNumber),
    cdId: text(staff?.cdId),
    rateUrl: slug ? `${origin.replace(/\/$/, "")}/sites/${slug}/` : null,
    timezone: text(branch?.timezone) ?? "America/Toronto",
    language: { code: "en", label: "English" },
    shopEmail: shopEmail && shopEmail.includes("@") ? shopEmail : null,
  };
}

export async function readReceiptOptions(db: Db, tenantId: string): Promise<ReceiptOptions> {
  const [tenant] = await db.select({ receiptSettings: schema.tenants.receiptSettings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return normalizeReceiptOptions(tenant?.receiptSettings);
}

export async function writeReceiptOptions(db: Db, tenantId: string, patch: Partial<ReceiptOptions>): Promise<ReceiptOptions> {
  const current = await readReceiptOptions(db, tenantId);
  const next = normalizeReceiptOptions({ ...current, ...patch });
  await db.update(schema.tenants).set({
    receiptSettings: { ...next } as Record<string, unknown>,
  }).where(eq(schema.tenants.id, tenantId));
  return next;
}

export function receiptPayload(options: ReceiptOptions, identity: ReceiptIdentity, emailConfigured: boolean, qrDataUrl: string | null) {
  return {
    options,
    identity,
    emailConfigured,
    closing: receiptClosing(options.footer),
    qrDataUrl: options.showQr && identity.rateUrl ? qrDataUrl : null,
  };
}
