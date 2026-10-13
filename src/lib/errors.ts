/**
 * Electron wraps errors thrown in the main process as
 * "Error invoking remote method 'name': Error: <message>". Show only <message>.
 */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(Error|TypeError|RangeError):\s*/, "")
    .trim();
}
