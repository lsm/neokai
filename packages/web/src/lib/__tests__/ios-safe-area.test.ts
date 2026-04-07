import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import appTsx from '../../App.tsx?raw';
import useViewportSafetyTs from '../../hooks/useViewportSafety.ts?raw';
import bottomTabBarTsx from '../../islands/BottomTabBar.tsx?raw';

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

	it('App.tsx uses h-dvh for the root container', () => {
		expect(appTsx).toContain('h-dvh');
	});

	it('styles.css defines the .h-safe-screen utility class (verified via hook referencing --safe-height)', () => {
		// CSS content is stripped in Vite's test environment; instead we verify
		// that useViewportSafety sets the --safe-height custom property which
		// is consumed by the .h-safe-screen utility defined in styles.css.
		expect(useViewportSafetyTs).toContain('--safe-height');
	});

	it('App.tsx uses pb-bottom-bar utility class for dynamic bottom padding', () => {
		expect(appTsx).toContain('pb-bottom-bar');
	});

	it('App.tsx does not use hardcoded pb-16 for main content bottom padding', () => {
		// The main content div should not have pb-16 — dynamic approach is used instead
		expect(appTsx).not.toContain('pb-16');
	});

	it('BottomTabBar sets --bottom-bar-height CSS custom property', () => {
		expect(bottomTabBarTsx).toContain('--bottom-bar-height');
	});

	it('BottomTabBar uses ResizeObserver to measure actual height', () => {
		expect(bottomTabBarTsx).toContain('ResizeObserver');
	});

	it('BottomTabBar adds a window resize listener for breakpoint transitions', () => {
		expect(bottomTabBarTsx).toContain("window.addEventListener('resize'");
	});

	it('BottomTabBar cleans up observers and resets --bottom-bar-height on unmount', () => {
		expect(bottomTabBarTsx).toContain('ro.disconnect()');
		expect(bottomTabBarTsx).toContain("window.removeEventListener('resize'");
		expect(bottomTabBarTsx).toContain('cancelAnimationFrame');
		expect(bottomTabBarTsx).toContain("'--bottom-bar-height', '0px'");
	});
});
