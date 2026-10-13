import fs from 'node:fs';
import crypto from 'node:crypto';

/** Thrown (as a rejection) when a hash is abandoned because the caller cancelled. */
export class HashAbortedError extends Error {
  constructor() {
    super('Hashing was cancelled');
    this.name = 'HashAbortedError';
  }
}

/**
 * Streaming SHA-256 of a whole file; never loads the file into memory.
 * An optional AbortSignal closes the stream early so long hashes can be cancelled.
 */
export function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HashAbortedError());

    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    const onAbort = () => {
      stream.destroy();
      reject(new HashAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);

    stream.on('error', (err) => {
      done();
      reject(err);
    });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      done();
      resolve(hash.digest('hex'));
    });
  });
}

/** SHA-256 of the first `bytes` bytes — a cheap pre-filter before a full hash. */
export async function hashHead(filePath: string, bytes = 64 * 1024): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle.close();
  }
}

/** True when both files have identical size and identical SHA-256. */
export async function filesIdentical(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([hashFile(a), hashFile(b)]);
  return ha === hb;
}
