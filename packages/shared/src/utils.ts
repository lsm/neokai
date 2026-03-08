/**
 * Render a template string by replacing {{variable}} placeholders with values.
 * Unmatched placeholders are left as-is.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
		return name in variables ? variables[name] : match;
	});
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
