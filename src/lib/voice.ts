import { randomBytes } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recorded delivery instructions ("Record — press here and hold"), kept on disk next to the images
 * (the Railway volume in production). Each customer has a folder; a note's name is 32 random hex
 * characters, so its address can only be found from the order it's attached to.
 */

/** A voice note's id as the app sends it. */
export const VOICE_ID_RE = /^[a-f0-9]{32}$/;
/** About a minute of AAC audio. */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

export class VoiceError extends Error {}

/** Phones record AAC in an MP4 container (.m4a): the bytes say "ftyp" at offset 4. */
function isMp4Audio(bytes: Buffer) {
  return bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
}

export class VoiceStore {
  constructor(readonly dir: string) {}

  /** "<userId>/<id>.m4a": what an order stores, and its path under /voice/. */
  key(userId: number, id: string) {
    return `${userId}/${id}.m4a`;
  }

  path(key: string) {
    return join(this.dir, ...key.split('/'));
  }

  has(userId: number, id: string) {
    return VOICE_ID_RE.test(id) ? access(this.path(this.key(userId, id))).then(() => true, () => false) : Promise.resolve(false);
  }

  async save(userId: number, bytes: Buffer): Promise<string> {
    if (bytes.length > MAX_VOICE_BYTES) throw new VoiceError('This recording is too long. Keep it under a minute.');
    if (!isMp4Audio(bytes)) throw new VoiceError('This doesn’t look like a voice recording.');
    const id = randomBytes(16).toString('hex');
    const file = this.path(this.key(userId, id));
    await mkdir(join(this.dir, String(userId)), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    return id;
  }

  /** Removes every recording a customer made (when they delete their account). */
  async removeUser(userId: number) {
    await rm(join(this.dir, String(userId)), { recursive: true, force: true });
  }
}
