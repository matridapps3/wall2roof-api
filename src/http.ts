import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { verifyAccessToken, type AccessClaims } from './lib/auth.js';

/** Error with an HTTP status and a message safe to show customers. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new HttpError(400, 'invalid_input', `${where}${first?.message ?? 'Invalid input'}`, r.error.issues);
  }
  return r.data;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims | null;
  }
}

/** Reads the Bearer token if present; routes decide whether it's required. */
export async function readAuth(req: FastifyRequest) {
  const h = req.headers.authorization;
  req.auth = h?.startsWith('Bearer ') ? await verifyAccessToken(h.slice(7)) : null;
}

export function requireUser(req: FastifyRequest): number {
  if (!req.auth) throw new HttpError(401, 'unauthenticated', 'Please log in to continue.');
  return Number(req.auth.sub);
}

export function requireAdmin(req: FastifyRequest): number {
  const id = requireUser(req);
  if (req.auth?.role !== 'admin') throw new HttpError(403, 'forbidden', 'Admins only.');
  return id;
}

export function sendError(reply: FastifyReply, e: HttpError) {
  return reply.status(e.status).send({ error: { code: e.code, message: e.message } });
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });
