import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import appTsx from '../../App.tsx?raw';

/**
 * iOS iPad Safari safe area support tests.
 *
 * These tests verify that the app correctly handles iOS safe areas
 * to prevent UI from being hidden behind Safari's tab bar/address bar.
 *
 * The safe area CSS utilities (pt-safe, pb-safe) using env(safe-area-inset-*)
 * are defined in src/styles.css — Vite strips CSS content in the test
 * environment so we verify their usage in source files instead.
 */
describe('iOS iPad Safari safe area support', () => {
	it('viewport meta tag includes viewport-fit=cover', () => {
		expect(indexHtml).toContain('viewport-fit=cover');
	});

	it('App.tsx applies pt-safe class to the root container for top safe area', () => {
		expect(appTsx).toContain('pt-safe');
	});
});
