import { describe, test, expect } from 'bun:test';
import { generateUUID } from '../src/utils.ts';

describe('generateUUID', () => {
	test('generates valid UUID format', () => {
		const uuid = generateUUID();
		// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test('generates unique UUIDs', () => {
		const uuid1 = generateUUID();
		const uuid2 = generateUUID();
		expect(uuid1).not.toBe(uuid2);
	});

	test('uses native crypto.randomUUID if available', () => {
		// In Bun, crypto.randomUUID should be available
		const uuid = generateUUID();
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test('fallback works when crypto.randomUUID is not available', () => {
		// Temporarily set crypto.randomUUID to undefined (delete doesn't work in Bun)
		const original = globalThis.crypto?.randomUUID;
		if (globalThis.crypto) {
			// @ts-expect-error - Intentionally setting to undefined for test
			globalThis.crypto.randomUUID = undefined;
		}

		const uuid = generateUUID();
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

		// Restore
		if (globalThis.crypto && original) {
			globalThis.crypto.randomUUID = original;
		}
	});

	test('fallback generates valid v4 UUID', () => {
		// Temporarily set crypto.randomUUID to undefined to force fallback
		const original = globalThis.crypto?.randomUUID;
		if (globalThis.crypto) {
			// @ts-expect-error - Intentionally setting to undefined for test
			globalThis.crypto.randomUUID = undefined;
		}

		const uuid = generateUUID();

		// Check version field (4)
		expect(uuid[14]).toBe('4');

		// Check variant field (8, 9, a, or b)
		expect(['8', '9', 'a', 'b']).toContain(uuid[19].toLowerCase());

		// Restore
		if (globalThis.crypto && original) {
			globalThis.crypto.randomUUID = original;
		}
	});

	test('generates multiple unique UUIDs in fallback mode', () => {
		const original = globalThis.crypto?.randomUUID;
		if (globalThis.crypto) {
			// @ts-expect-error - Intentionally setting to undefined for test
			globalThis.crypto.randomUUID = undefined;
		}

		const uuids = new Set();
		for (let i = 0; i < 100; i++) {
			uuids.add(generateUUID());
		}

		expect(uuids.size).toBe(100); // All unique

		// Restore
		if (globalThis.crypto && original) {
			globalThis.crypto.randomUUID = original;
		}
	});
});
