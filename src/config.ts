import 'dotenv/config';
import { join } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Railway sets DATABASE_URL for its PostgreSQL service. When it's missing
   * (local development) the server uses an embedded Postgres (PGlite) in .data/.
   */
  DATABASE_URL: z.string().url().optional(),
  PGLITE_DIR: z.string().default('./.data/pglite'),
  /** Secret for signing access tokens. Required in production. */
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().default(30),
  /** How long a login lasts without opening the app; every use starts the count again. */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(365),
  /**
   * OTP delivery. `console` prints the code in the server log and returns it to the app
   * (development only). `test` does the same on the live server while the app is being built —
   * no SMS, anyone can log in to any number, so never with real customers. `msg91` sends a real SMS.
   */
  OTP_PROVIDER: z.enum(['console', 'test', 'msg91']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  CORS_ORIGINS: z.string().default('*'),
  /**
   * Shared secret for the Wall2Roof admin integration API (/v1/integration).
   * At least 32 characters; while unset the integration API answers 503.
   * Same value as ELECTRODASH_ADMIN_KEY in the Wall2Roof app's .env.
   */
  WALL2ROOF_ADMIN_KEY: z.string().optional(),
  /**
   * Where the server keeps its own copies of images. Default: the Railway volume
   * (RAILWAY_VOLUME_MOUNT_PATH/images, set by Railway when a volume is attached), else ./.data/images.
   */
  IMAGES_DIR: z.string().optional(),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().optional(),
  /** This server's public address, used in links to its images. Railway sets RAILWAY_PUBLIC_DOMAIN. */
  PUBLIC_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  /** `off` stops the background job that copies outside images onto this server. */
  IMAGE_IMPORT: z.enum(['on', 'off']).default('on'),
});

// Treat blank lines in .env (e.g. `DATABASE_URL=`) as "not set".
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const parsed = schema.safeParse(rawEnv);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

if (env.NODE_ENV === 'production') {
  const missing = [
    !env.DATABASE_URL && 'DATABASE_URL',
    !env.JWT_SECRET && 'JWT_SECRET',
    env.OTP_PROVIDER === 'console' && 'OTP_PROVIDER (console is development-only)',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Refusing to start in production without: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const publicUrl = (env.PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, '') || null;
const imagesPersistent = !!(env.IMAGES_DIR || env.RAILWAY_VOLUME_MOUNT_PATH);

export const config = {
  ...env,
  imagesDir: env.IMAGES_DIR ?? (env.RAILWAY_VOLUME_MOUNT_PATH ? join(env.RAILWAY_VOLUME_MOUNT_PATH, 'images') : './.data/images'),
  imagesPersistent,
  /** Recorded delivery instructions, next to the images (the Railway volume in production). */
  voiceDir: env.RAILWAY_VOLUME_MOUNT_PATH ? join(env.RAILWAY_VOLUME_MOUNT_PATH, 'voice') : './.data/voice',
  publicUrl,
  /**
   * Copy outside images only where the copies are kept (a volume) and reachable (a public https
   * address) — never from a developer's PC, which shares the production database.
   */
  imageImport: env.IMAGE_IMPORT === 'on' && imagesPersistent && !!publicUrl?.startsWith('https://'),
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  jwtSecret: new TextEncoder().encode(env.JWT_SECRET ?? 'dev-only-secret-change-me-dev-only-secret'),
};
