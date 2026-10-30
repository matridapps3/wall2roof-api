import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { FeeSettings } from './pricing.js';

/**
 * Business settings, editable by the admin without an app release. The
 * delivery promise is data, not code: the app shows whatever is set here.
 */
export type StoreSettings = FeeSettings & {
  /** e.g. "12 minutes". Empty string = don't show a time promise. */
  deliveryEtaText: string;
  storeAreaText: string;
  /** Empty list = deliver to every PIN code. */
  serviceablePincodes: string[];
  supportPhone: string;
  supportEmail: string;
  supportHoursText: string;
  codEnabled: boolean;
  onlinePaymentsEnabled: boolean;
  /**
   * Test login while the app is being built and no SMS provider is bought yet: no SMS is sent
   * and the code for ANY number is filled in by the app. Never with real customers.
   */
  testLogin: boolean;
  /**
   * The newest installable app (APK) and where to download it. Apps older than this version show
   * "New version available — Download". Empty = no message. Small changes reach phones as
   * over-the-air updates instead; this is only for changes that need a new APK.
   */
  latestAppVersion: string;
  latestAppUrl: string;
  /**
   * Show customers' written reviews on product pages (each with Report / Block). Off (default) =
   * like Blinkit: only the stars (average, count, 5→1 bars); what customers write reaches only staff.
   * Turning it on also needs the app's rating box ("only our team sees this") and Terms changed back.
   */
  writtenReviews: boolean;
};

export const DEFAULT_SETTINGS: StoreSettings = {
  deliveryFeePaise: 2500,
  freeDeliveryMinPaise: 19900,
  handlingFeePaise: 500,
  codFeePaise: 1000,
  deliveryEtaText: '',
  storeAreaText: '',
  serviceablePincodes: [],
  supportPhone: '',
  supportEmail: '',
  supportHoursText: '',
  codEnabled: true,
  onlinePaymentsEnabled: false,
  testLogin: false,
  latestAppVersion: '',
  latestAppUrl: '',
  writtenReviews: false,
};

export async function getSettings(db: Db): Promise<StoreSettings> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out as StoreSettings;
}

export async function setSetting<K extends keyof StoreSettings>(db: Db, key: K, value: StoreSettings[K]) {
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

export function isServiceable(s: StoreSettings, pincode: string): boolean {
  return s.serviceablePincodes.length === 0 || s.serviceablePincodes.includes(pincode);
}
