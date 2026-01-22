/**
 * Vitest Setup File
 *
 * This file runs before all tests to set up the test environment.
 * Note: happy-dom environment is automatically initialized by vitest.config.ts
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Mock window.location with specific values (happy-dom doesn't set all properties)
Object.defineProperty(global.window, 'location', {
	value: {
		href: 'http://localhost:9283',
		origin: 'http://localhost:9283',
		protocol: 'http:',
		host: 'localhost:9283',
		hostname: 'localhost',
		port: '9283',
		pathname: '/',
		search: '',
		hash: '',
	},
	writable: true,
});

// Mock localStorage
const localStorageMock = {
	getItem: vi.fn(() => null),
	setItem: vi.fn(() => {}),
	removeItem: vi.fn(() => {}),
	clear: vi.fn(() => {}),
	length: 0,
	key: vi.fn(() => null),
};
global.localStorage = localStorageMock as unknown as Storage;

beforeEach(() => {
	// Clear all mocks before each test
	vi.clearAllMocks();
	localStorageMock.getItem.mockClear();
	localStorageMock.setItem.mockClear();
	localStorageMock.removeItem.mockClear();
	localStorageMock.clear.mockClear();
});

afterEach(() => {
	// Cleanup after each test
	vi.restoreAllMocks();
});
