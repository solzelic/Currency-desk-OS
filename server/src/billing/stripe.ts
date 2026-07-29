import Stripe from "stripe";
import type { TenantPlan } from "../db/schema.js";

export type BillingCycle = "monthly" | "annual";

export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret?: string;
  appBaseUrl?: string;
  prices: Record<TenantPlan, Record<BillingCycle, string | undefined>>;
  kycMeterEventName?: string;
}

const requiredPlanNames: readonly TenantPlan[] = ["basic", "pro", "premium"];

export function stripeBillingConfig(): StripeBillingConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
    appBaseUrl: process.env.APP_BASE_URL?.trim().replace(/\/$/, "") || undefined,
    prices: {
      basic: { monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY, annual: process.env.STRIPE_PRICE_BASIC_ANNUAL },
      pro: { monthly: process.env.STRIPE_PRICE_PRO_MONTHLY, annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
      premium: { monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY, annual: process.env.STRIPE_PRICE_PREMIUM_ANNUAL },
    },
    kycMeterEventName: process.env.STRIPE_KYC_METER_EVENT_NAME?.trim() || undefined,
  };
}

export function configuredPrice(config: StripeBillingConfig, plan: TenantPlan, cycle: BillingCycle): string | null {
  const price = config.prices[plan][cycle]?.trim();
  return price || null;
}

export function planForPrice(config: StripeBillingConfig, priceId: string | null): TenantPlan | null {
  if (!priceId) return null;
  for (const plan of requiredPlanNames) {
    if (config.prices[plan].monthly === priceId || config.prices[plan].annual === priceId) return plan;
  }
  return null;
}

export function stripeClient(config: StripeBillingConfig): Stripe {
  return new Stripe(config.secretKey, { apiVersion: "2026-06-24.dahlia", maxNetworkRetries: 2 });
}

export function safeAppBaseUrl(config: StripeBillingConfig, host: string | undefined): string | null {
  const candidate = config.appBaseUrl ?? (process.env.NODE_ENV === "production" ? undefined : host ? `http://${host}` : undefined);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}
