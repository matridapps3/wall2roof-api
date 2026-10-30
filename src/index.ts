import { buildApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/client.js';
import { startImageCopying } from './jobs/copy-images.js';
import { ImageStore } from './lib/images.js';
import { isTestLogin } from './lib/otp-sender.js';
import { getSettings } from './lib/settings.js';

const { db, close } = await openDb();
const images = new ImageStore(config.imagesDir);
const app = await buildApp(db, {}, { images });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });

if (config.isProd && isTestLogin(await getSettings(db).then((s) => s.testLogin, () => false))) {
  app.log.warn(
    'TEST LOGIN IS ON (OTP_PROVIDER=test or the testLogin setting): no SMS is sent and the code for ANY phone number ' +
      'is shown in the app. Turn it off and use OTP_PROVIDER=messagecentral (or msg91) with its keys before real customers use the app.',
  );
}

if (config.imageImport && config.publicUrl) {
  app.log.info({ dir: config.imagesDir, publicUrl: config.publicUrl }, 'copying outside images onto this server');
  startImageCopying(db, images, config.publicUrl, app.log);
} else {
  app.log.info({ dir: config.imagesDir, persistent: config.imagesPersistent }, 'image copying is off (needs a volume and a public https address)');
}
