import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { orderItems, orders, users } from '../db/schema.js';
import { HttpError, parse, requireStaff } from '../http.js';
import { changeOrderStatus, loadStoreOrder, orderActor } from './orders.js';

/**
 * "Store orders" in the app, for staff and admins: the orders to pick, pack and send out.
 * The app names the steps its own way (New, Picked, Packed, Dispatched); the statuses here,
 * and what customers see, stay as they are.
 */

const STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled'] as const;
/** Orders still to be sent out or delivered (the default list). */
const ACTIVE = ['placed', 'confirmed', 'packed', 'out_for_delivery'] as const;

type OrderRow = typeof orders.$inferSelect;

function card(o: OrderRow, customer: { name: string | null; phone: string | null }, itemCount: number) {
  return {
    number: o.number,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    itemCount,
    totalPaise: o.totalPaise,
    paymentMethod: o.paymentMethod,
    customerName: customer.name,
    customerPhone: customer.phone,
    city: o.address.city,
    pincode: o.address.pincode,
  };
}

/** The order page staff work from: what to pick, where it goes, the bill and who did what. */
async function staffOrder(db: Db, number: string) {
  const { o, u, items, events, nextStatuses } = await loadStoreOrder(db, number);
  return {
    ...card(o, u, items.reduce((n, i) => n + i.qty, 0)),
    paymentStatus: o.paymentStatus,
    address: o.address,
    deliveryInstructions: o.deliveryInstructions,
    /** path on this server, e.g. /voice/12/<id>.m4a */
    voiceNoteUrl: o.voiceNote ? `/voice/${o.voiceNote}` : null,
    items: items.map((i) => ({ sku: i.sku, name: i.name, image: i.image, qty: i.qty, unitPricePaise: i.unitPricePaise })),
    subtotalPaise: o.subtotalPaise,
    deliveryFeePaise: o.deliveryFeePaise,
    handlingFeePaise: o.handlingFeePaise,
    codFeePaise: o.codFeePaise,
    discountPaise: o.discountPaise,
    tipPaise: o.tipPaise,
    gstin: o.gstin,
    businessName: o.gstBusinessName,
    cancelReason: o.cancelReason,
    events: events.map((e) => ({ status: e.status, note: e.note, at: e.createdAt.toISOString(), by: e.actorLabel })),
    nextStatuses,
  };
}

export async function staffRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/staff/orders', async (req) => {
    requireStaff(req);
    const { status } = parse(z.object({ status: z.enum(['active', ...STATUSES]).default('active') }), req.query);
    const rows = await db
      .select({ o: orders, name: users.name, phone: users.phone })
      .from(orders)
      .innerJoin(users, eq(users.id, orders.userId))
      .where(status === 'active' ? inArray(orders.status, [...ACTIVE]) : eq(orders.status, status))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(100);
    const counts = rows.length
      ? await db
          .select({ orderId: orderItems.orderId, n: sql<number>`sum(${orderItems.qty})::int` })
          .from(orderItems)
          .where(inArray(orderItems.orderId, rows.map((r) => r.o.id)))
          .groupBy(orderItems.orderId)
      : [];
    const byOrder = new Map(counts.map((c) => [c.orderId, c.n]));
    return { orders: rows.map(({ o, name, phone }) => card(o, { name, phone }, byOrder.get(o.id) ?? 0)) };
  });

  app.get('/v1/staff/orders/:number', async (req) => {
    requireStaff(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    return { order: await staffOrder(db, number) };
  });

  /** Mark picked / packed / dispatched / delivered, or cancel with a reason. */
  app.post('/v1/staff/orders/:number/status', async (req) => {
    const userId = requireStaff(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        status: z.enum(['confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled']),
        note: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    if (body.status === 'cancelled' && !body.note) throw new HttpError(400, 'reason_required', 'Enter why the order is being cancelled.');
    await changeOrderStatus(db, number, body.status, body.note || undefined, await orderActor(db, userId));
    return { ok: true, order: await staffOrder(db, number) };
  });
}
