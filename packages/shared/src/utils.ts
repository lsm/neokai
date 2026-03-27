export const SHORT_ID_PREFIX = {
	TASK: 't',
	GOAL: 'g',
} as const;

export function formatShortId(prefix: string, counter: number): string {
	return `${prefix}-${counter}`;
}

export function parseShortId(shortId: string): { prefix: string; counter: number } | null {
	const match = shortId.match(/^([a-z])-(\d+)$/);
	if (!match) return null;
	const counter = parseInt(match[2], 10);
	if (counter < 1) return null;
	return { prefix: match[1], counter };
}

export function isUUID(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Generate a UUID v4 (browser and Node.js compatible)
 * Uses crypto.randomUUID() if available, otherwise falls back to a polyfill
 */
export function generateUUID(): string {
	// Try to use the native crypto.randomUUID() if available
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}

	// Fallback for older browsers and environments (UUID v4 format)
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
