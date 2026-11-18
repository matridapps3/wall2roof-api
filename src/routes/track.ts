import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/client.js';
import { orderEvents, orderItems, orders } from '../db/schema.js';
import { esc } from '../lib/html.js';
import { isTrackKey } from '../lib/track-link.js';
import { page } from './pages.js';

/**
 * The order page behind a shared tracking link (/track/<number>/<key>): anyone with the link can
 * follow the order without the app or a login. It shows the status and its steps, the items and
 * the town, never the name, phone, street address or prices. While the order is on its way the
 * page fetches itself every 30 seconds and swaps in the new status.
 */

type Status = (typeof orders.$inferSelect)['status'];

const STEPS: { status: Status; label: string }[] = [
  { status: 'placed', label: 'Order placed' },
  { status: 'confirmed', label: 'Confirmed by the shop' },
  { status: 'packed', label: 'Packed' },
  { status: 'out_for_delivery', label: 'On the way' },
  { status: 'delivered', label: 'Delivered' },
];

const HEADLINE: Record<Status, string> = {
  placed: 'Order placed',
  confirmed: 'Order confirmed',
  packed: 'Order packed',
  out_for_delivery: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Order cancelled',
};

const LINE: Record<Exclude<Status, 'delivered'>, string> = {
  placed: 'The shop will confirm it shortly.',
  confirmed: 'The shop has confirmed the order and is getting it ready.',
  packed: 'The order is packed and will be on its way soon.',
  out_for_delivery: 'The delivery partner is on the way with the order.',
  cancelled: 'This order was cancelled.',
};

const REFRESH_MS = 30_000;

// Indian time, whatever the server's clock is set to
const clock = (d: Date) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

/** A photo kept on this server comes in a small size made for it (like the app asks for). */
const thumb = (url: string) => (/\/img\/[a-f0-9]{32}\.(jpg|png|webp|gif|avif)$/.test(url) ? `${url}?w=160` : url);

const CSS = `
  .status { font-size: 30px; line-height: 1.2; margin: 4px 0; }
  .status.live { color: var(--primary); }
  .status.cancelled { color: #C0392B; }
  .steps { list-style: none; padding: 0; margin: 0; }
  .steps li { position: relative; display: flex; justify-content: space-between; gap: 12px; padding: 0 0 18px 30px; color: var(--muted); }
  .steps li:last-child { padding-bottom: 0; }
  .steps li::before { content: ''; position: absolute; left: 0; top: 4px; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line); background: var(--card); box-sizing: border-box; }
  .steps li:not(:last-child)::after { content: ''; position: absolute; left: 7px; top: 22px; bottom: 2px; width: 2px; background: var(--line); }
  .steps li.done { color: var(--text); font-weight: 600; }
  .steps li.done::before { background: var(--primary); border-color: var(--primary); }
  .steps li.past::after { background: var(--primary); }
  .steps li.now::before { box-shadow: 0 0 0 5px rgba(11, 95, 165, 0.18); }
  .steps time { font-weight: 400; color: var(--muted); white-space: nowrap; }
  .items { list-style: none; padding: 0; margin: 0; }
  .items li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
  .items li:first-child { border-top: 0; padding-top: 0; }
  .items img, .items .ph { width: 48px; height: 48px; border-radius: 10px; object-fit: contain; background: #fff; border: 1px solid var(--line); flex: none; }
  .items .name { flex: 1; }
  .items .qty { color: var(--muted); white-space: nowrap; }
  h2.card-title { margin: 0 0 12px; font-size: 17px; }
`;

/** Every 30 seconds, while the order isn't finished: fetch this page again and swap in the new <main>. */
const SCRIPT = `(function () {
  var m = document.querySelector('main');
  if (!m || m.getAttribute('data-final') === '1' || !window.fetch || !window.DOMParser) return;
  var timer = setInterval(function () {
    fetch(location.href, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
        if (!next) return;
        document.querySelector('main').replaceWith(next);
        if (next.getAttribute('data-final') === '1') clearInterval(timer);
      })
      .catch(function () {});
  }, ${REFRESH_MS});
})();`;

function notFound() {
  return page('Tracking link not valid', `<h1>This tracking link isn’t valid</h1><p>Ask the person who sent it to share it again from the ElectroDash app (Your orders → the order → Share live tracking).</p>`, { private: true });
}

export async function trackRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/track/:number/:key', async (req, reply) => {
    const { number, key } = req.params as { number: string; key: string };
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow');
    if (number.length > 40 || key.length > 64 || !isTrackKey(number, key)) return reply.code(404).send(notFound());
    const [o] = await db.select().from(orders).where(eq(orders.number, number));
    if (!o) return reply.code(404).send(notFound());

    const [items, events] = await Promise.all([
      db.select({ name: orderItems.name, image: orderItems.image, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(asc(orderItems.id)),
      db.select({ status: orderEvents.status, at: orderEvents.createdAt }).from(orderEvents).where(eq(orderEvents.orderId, o.id)).orderBy(asc(orderEvents.createdAt)),
    ]);
    const reachedAt = new Map<Status, Date>();
    for (const e of events) if (!reachedAt.has(e.status)) reachedAt.set(e.status, e.at);

    const cancelled = o.status === 'cancelled';
    const final = cancelled || o.status === 'delivered';
    const current = STEPS.findIndex((s) => s.status === o.status);
    const deliveredAt = reachedAt.get('delivered');
    const line = o.status === 'delivered' ? (deliveredAt ? `Delivered at ${clock(deliveredAt)}, ${day(deliveredAt)}.` : 'The order has been delivered.') : LINE[o.status];

    const steps = cancelled
      ? ''
      : `<div class="card"><ol class="steps">${STEPS.map((s, i) => {
          const at = reachedAt.get(s.status) ?? (i <= current && i === 0 ? o.createdAt : undefined);
          // done: reached; past: the line down to the next step is blue too; now: the step it's at
          const cls = [i <= current && 'done', i < current && 'past', i === current && !final && 'now'].filter(Boolean).join(' ');
          return `<li${cls ? ` class="${cls}"` : ''}><span>${esc(s.label)}</span>${at && i <= current ? `<time>${esc(clock(at))}</time>` : ''}</li>`;
        }).join('')}</ol></div>`;

    const count = items.reduce((n, i) => n + i.qty, 0);
    const itemList = `<div class="card"><h2 class="card-title">${count} ${count === 1 ? 'item' : 'items'}</h2><ul class="items">${items
      .map(
        (i) =>
          `<li>${i.image ? `<img src="${esc(thumb(i.image))}" alt="" loading="lazy">` : '<span class="ph"></span>'}<span class="name">${esc(i.name)}</span><span class="qty">× ${i.qty}</span></li>`,
      )
      .join('')}</ul></div>`;

    const town = [o.address.city, o.address.pincode].filter(Boolean).join(' ');
    const body = `
<p class="muted">Order #${esc(o.number)} · placed ${esc(day(o.createdAt))}, ${esc(clock(o.createdAt))}</p>
<h1 class="status${cancelled ? ' cancelled' : final ? '' : ' live'}">${esc(HEADLINE[o.status])}</h1>
<p>${esc(line)}</p>
${steps}
${itemList}
${town ? `<div class="card"><h2 class="card-title">${o.status === 'delivered' ? 'Delivered to' : 'Delivering to'}</h2><p style="margin:0">${esc(town)}</p></div>` : ''}
<p class="muted">${final ? '' : `Updated ${esc(clock(new Date()))}. This page updates by itself.`}</p>
`;
    return reply.send(page(`Order ${o.number}`, body, { css: CSS, script: final ? undefined : SCRIPT, main: `data-final="${final ? 1 : 0}"`, private: true }));
  });
}
