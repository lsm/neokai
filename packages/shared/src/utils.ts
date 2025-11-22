/**
 * Generate a UUID v4 (browser and Node.js compatible)
 * Uses crypto.randomUUID() if available, otherwise falls back to a polyfill
 */
export function generateUUID(): string {
  // Try to use the native crypto.randomUUID() if available
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  // Fallback for older browsers and environments (UUID v4 format)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
