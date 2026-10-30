import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { productReviews, reviewReports, userBlocks } from '../db/schema.js';
import { HttpError, parse, requireUser } from '../http.js';
import { refreshProductRatings } from '../lib/reviews.js';

/**
 * Customers' tools against bad reviews (App Store guideline 1.2): "Report review" hides it from
 * everyone straight away until staff check it (Wall2Roof → reported reviews), and "Block" stops
 * showing that person's reviews to the customer who blocked them.
 */
const reviewParams = z.object({ id: z.coerce.number().int().positive() });

async function loadReview(db: Db, id: number) {
  const [r] = await db
    .select({ id: productReviews.id, userId: productReviews.userId, productId: productReviews.productId, hiddenAt: productReviews.hiddenAt })
    .from(productReviews)
    .where(eq(productReviews.id, id));
  if (!r) throw new HttpError(404, 'not_found', 'This review isn’t shown any more.');
  return r;
}

export async function reviewRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.post('/v1/reviews/:id/report', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(reviewParams, req.params);
    const { reason } = parse(z.object({ reason: z.enum(['offensive', 'spam', 'not_about_product', 'other']) }), req.body ?? {});
    const r = await loadReview(db, id);
    if (r.userId === userId) throw new HttpError(400, 'own_review', 'You can’t report your own review.');
    await db.insert(reviewReports).values({ reviewId: id, userId, reason }).onConflictDoNothing();
    if (!r.hiddenAt) {
      await db.update(productReviews).set({ hiddenAt: new Date() }).where(eq(productReviews.id, id));
      await refreshProductRatings(db, [r.productId]);
    }
    return { ok: true };
  });

  app.post('/v1/reviews/:id/block-author', async (req) => {
    const userId = requireUser(req);
    const { id } = parse(reviewParams, req.params);
    const r = await loadReview(db, id);
    if (r.userId === userId) throw new HttpError(400, 'own_review', 'You can’t block yourself.');
    await db.insert(userBlocks).values({ userId, blockedUserId: r.userId }).onConflictDoNothing();
    return { ok: true };
  });
}
