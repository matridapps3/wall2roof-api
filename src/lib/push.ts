import { and, eq, exists, gt, inArray, isNull } from 'drizzle-orm';

import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { staffAccounts, staffPushTokens, staffSessions } from '../db/schema.js';
import { rupees } from './mailer.js';

/**
 * Push notifications to the admin app's phones through Expo's push service (it passes them on to
 * Google / Apple). Plain HTTPS; EXPO_ACCESS_TOKEN only when "enhanced push security" is turned on
 * for the Expo project.
 */

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo takes at most 100 messages per request. */
const BATCH = 100;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  priority: 'high';
  /** the Android notification channel the admin app makes */
  channelId: string;
};
/** Expo's answer per message, in the same order as the messages. */
export type PushTicket = { status: 'ok'; id?: string } | { status: 'error'; message?: string; details?: { error?: string } };
export type PushSender = { send(messages: PushMessage[]): Promise<PushTicket[]> };

type ExpoRequestError = { code?: unknown; message?: unknown; details?: unknown };

/** Expo turned the whole request down: nothing in it was sent. The message names Expo's error codes only, never push tokens. */
class ExpoPushError extends Error {
  constructor(
    status: number,
    readonly errors: ExpoRequestError[],
  ) {
    super(`Expo push error (${status})${errors.length ? ` ${errors.map((e) => (typeof e.code === 'string' ? e.code : 'unknown')).join(', ')}` : ''}`);
  }
}

/**
 * Phones of different Expo projects can't share a request (PUSH_TOO_MANY_EXPERIENCE_IDS, e.g. a phone
 * still on a build from an older project): Expo lists each project's tokens, and the batch is split by them.
 */
function byProject(e: unknown, batch: PushMessage[]): PushMessage[][] | null {
  if (!(e instanceof ExpoPushError)) return null;
  const details = e.errors.find((x) => x.code === 'PUSH_TOO_MANY_EXPERIENCE_IDS')?.details;
  if (!details || typeof details !== 'object') return null;
  const groups = Object.values(details)
    .filter((tokens): tokens is unknown[] => Array.isArray(tokens))
    .map((tokens) => batch.filter((m) => tokens.includes(m.to)))
    .filter((g) => g.length > 0);
  return groups.length > 1 ? groups : null;
}

const errorTicket = (e: unknown): PushTicket => ({ status: 'error', message: e instanceof Error ? e.message : String(e) });

export function expoPushSender(accessToken?: string): PushSender {
  async function post(batch: PushMessage[]): Promise<PushTicket[]> {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(batch),
      // never retried, so a phone can't get the same alert twice
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; errors?: unknown } | null;
    if (!res.ok || !Array.isArray(json?.data) || json.data.length !== batch.length) {
      throw new ExpoPushError(res.status, Array.isArray(json?.errors) ? (json.errors as ExpoRequestError[]) : []);
    }
    return json.data as PushTicket[];
  }

  return {
    async send(messages) {
      const tickets: PushTicket[] = [];
      for (let i = 0; i < messages.length; i += BATCH) {
        const batch = messages.slice(i, i + BATCH);
        try {
          tickets.push(...(await post(batch)));
        } catch (e) {
          const groups = byProject(e, batch);
          if (!groups) {
            // one failed request doesn't stop the other batches
            tickets.push(...batch.map(() => errorTicket(e)));
            continue;
          }
          // the request was refused as a whole, so sending each project's part now sends nothing twice
          const answered = new Map<PushMessage, PushTicket>();
          for (const g of groups) {
            const got = await post(g).catch((err: unknown) => g.map(() => errorTicket(err)));
            g.forEach((m, j) => answered.set(m, got[j]));
          }
          tickets.push(...batch.map((m) => answered.get(m) ?? errorTicket(e)));
        }
      }
      return tickets;
    },
  };
}

/** The live sender (none in tests). */
export function defaultPushSender(c: Pick<typeof config, 'isTest' | 'EXPO_ACCESS_TOKEN'> = config): PushSender | null {
  return c.isTest ? null : expoPushSender(c.EXPO_ACCESS_TOKEN);
}

export type NewOrderPush = { number: string; totalPaise: number; itemCount: number; city: string; pincode: string };

/** "New order ED-2026-10042" / "₹1,250 · 3 items · Mohali 140306"; tapping it opens the order. */
export function newOrderPush(o: NewOrderPush, to: string): PushMessage {
  return {
    to,
    title: `New order ${o.number}`,
    body: `${rupees(o.totalPaise)} · ${o.itemCount} item${o.itemCount === 1 ? '' : 's'} · ${o.city} ${o.pincode}`,
    data: { type: 'new_order', number: o.number },
    sound: 'default',
    priority: 'high',
    channelId: 'orders',
  };
}

const gone = (t: PushTicket | undefined) => t?.status === 'error' && t.details?.error === 'DeviceNotRegistered';

/**
 * Tells the phones of every active staff member who is still logged in somewhere about a new order, in
 * the background: never awaited, so the customer's order can't fail or wait on it. Phones whose app was
 * uninstalled (Expo answers DeviceNotRegistered) are forgotten; other failures are only logged.
 */
export function pushNewOrder(db: Db, sender: PushSender | null | undefined, o: NewOrderPush, onError: (err: unknown) => void) {
  if (!sender) return;
  const s = sender;
  void (async () => {
    const now = new Date();
    const rows = await db
      .select({ token: staffPushTokens.token })
      .from(staffPushTokens)
      .innerJoin(staffAccounts, eq(staffAccounts.id, staffPushTokens.staffId))
      .where(
        and(
          eq(staffAccounts.active, true),
          // someone whose every login has ended (90 days unused, logged out) gets no alerts
          exists(
            db
              .select({ id: staffSessions.id })
              .from(staffSessions)
              .where(and(eq(staffSessions.staffId, staffAccounts.id), isNull(staffSessions.revokedAt), gt(staffSessions.expiresAt, now))),
          ),
        ),
      );
    if (!rows.length) return;
    const messages = rows.map((r) => newOrderPush(o, r.token));
    const tickets = await s.send(messages);
    const dead = messages.filter((_, i) => gone(tickets[i])).map((m) => m.to);
    if (dead.length) await db.delete(staffPushTokens).where(inArray(staffPushTokens.token, dead));
    const failed = tickets.filter((t) => t.status === 'error' && !gone(t));
    if (failed.length) {
      // Expo's error code first: its messages can name the push token
      const why = [...new Set(failed.map((t) => (t.status === 'error' ? (t.details?.error ?? t.message ?? 'unknown') : '')))].join('; ');
      throw new Error(`${failed.length} of ${messages.length} new-order pushes failed: ${why.slice(0, 300)}`);
    }
  })().catch(onError);
}
