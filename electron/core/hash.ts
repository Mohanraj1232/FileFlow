import fs from 'node:fs';
import crypto from 'node:crypto';

/** Streaming SHA-256 of a whole file; never loads the file into memory. */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
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
