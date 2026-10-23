import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HttpError, parse, requireUser } from '../http.js';
import { MAX_VOICE_BYTES, VOICE_ID_RE, VoiceError, type VoiceStore } from '../lib/voice.js';

/**
 * Voice instructions for the delivery partner. The app uploads the recording (raw audio/mp4) right
 * after it's made and sends its id with the order; `/voice/<userId>/<id>.m4a` plays it (the admin's
 * order page links to it).
 */
export async function voiceRoutes(app: FastifyInstance, { store }: { store: VoiceStore }) {
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_VOICE_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.post('/v1/voice-notes', async (req, reply) => {
    const userId = requireUser(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'invalid_audio', 'Send the recording as audio/mp4.');
    try {
      const id = await store.save(userId, req.body);
      reply.status(201);
      return { id };
    } catch (e) {
      if (e instanceof VoiceError) throw new HttpError(400, 'invalid_audio', e.message);
      throw e;
    }
  });

  app.get('/voice/:user/:file', async (req, reply) => {
    const { user, file } = parse(z.object({ user: z.string().regex(/^\d{1,10}$/), file: z.string().max(40) }), req.params);
    const id = file.replace(/\.m4a$/, '');
    if (!file.endsWith('.m4a') || !VOICE_ID_RE.test(id) || !(await store.has(Number(user), id))) {
      throw new HttpError(404, 'not_found', 'No such recording.');
    }
    return reply.header('cache-control', 'private, max-age=86400').type('audio/mp4').send(createReadStream(store.path(store.key(Number(user), id))));
  });
}
