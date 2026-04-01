/**
 * iPad Safari Layout E2E Tests
 *
 * Verifies responsive layout behavior at iPad and desktop viewport sizes.
 * Tests verify CSS class usage, element visibility, and computed styles
 * (padding-bottom) — not raw CSS custom property values.
 *
 * NOTE: Manual device testing on real iPad Safari is still required to verify
 * the actual tab bar overlay fix. Safari's compact tab bar overlay behavior
 * cannot be replicated with Playwright viewport emulation. These tests serve
 * as regression guards for the responsive layout logic.
 */

import { test, expect } from '../../fixtures';

// ---------------------------------------------------------------------------
// Viewport constants
// ---------------------------------------------------------------------------

const IPAD_PORTRAIT = { width: 820, height: 1180 } as const;
const IPAD_MINI_PORTRAIT = { width: 744, height: 1133 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

// ---------------------------------------------------------------------------
// iPad portrait (820×1180) — standard iPad
// ---------------------------------------------------------------------------

test.describe('iPad portrait (820×1180)', () => {
	test.use({ viewport: IPAD_PORTRAIT, hasTouch: true, isMobile: false });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
	});

	test('root container uses h-safe-screen class', async ({ page }) => {
		const rootContainer = page.locator('.h-safe-screen').first();
		await expect(rootContainer).toBeAttached();
		const classes = await rootContainer.getAttribute('class');
		expect(classes).toContain('h-safe-screen');
	});

	test('header element is visible within the viewport bounds', async ({ page }) => {
		const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
		await expect(heading).toBeVisible();
		const box = await heading.boundingBox();
		expect(box).not.toBeNull();
		// Header must be within the visible area (not hidden behind a tab bar)
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeGreaterThan(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(IPAD_PORTRAIT.height);
	});
});

// ---------------------------------------------------------------------------
// iPad Mini portrait (744×1133) — width < md breakpoint (768px)
// BottomTabBar visible; main content should have non-zero padding-bottom
// ---------------------------------------------------------------------------

test.describe('iPad Mini portrait (744×1133)', () => {
	test.use({ viewport: IPAD_MINI_PORTRAIT, hasTouch: true, isMobile: false });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
	});

	test('root container uses h-safe-screen class', async ({ page }) => {
		const rootContainer = page.locator('.h-safe-screen').first();
		await expect(rootContainer).toBeAttached();
		const classes = await rootContainer.getAttribute('class');
		expect(classes).toContain('h-safe-screen');
	});

	test('header element is visible within the viewport bounds', async ({ page }) => {
		const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
		await expect(heading).toBeVisible();
		const box = await heading.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.y).toBeGreaterThanOrEqual(0);
		expect(box!.y + box!.height).toBeGreaterThan(0);
		expect(box!.y + box!.height).toBeLessThanOrEqual(IPAD_MINI_PORTRAIT.height);
	});

	test('bottom tab bar is visible at narrow width', async ({ page }) => {
		// At 744px (<768px md breakpoint) BottomTabBar is not hidden
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await expect(bottomTabBar).toBeVisible();
	});

	test('main content area has non-zero computed padding-bottom', async ({ page }) => {
		// Wait for the BottomTabBar's ResizeObserver to fire and update --bottom-bar-height
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await expect(bottomTabBar).toBeVisible();

		const paddingBottom = await page.evaluate(() => {
			const el = document.querySelector('.pb-bottom-bar');
			if (!el) return '0px';
			return getComputedStyle(el).paddingBottom;
		});

		// The BottomTabBar is rendered at this width, so padding-bottom should be > 0
		expect(paddingBottom).not.toBe('0px');
		// Sanity check: padding-bottom should be a reasonable pixel value
		const px = parseFloat(paddingBottom);
		expect(px).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Desktop (1280×800) — above md breakpoint
// BottomTabBar hidden; main content should have 0px padding-bottom
// ---------------------------------------------------------------------------

test.describe('Desktop (1280×800)', () => {
	test.use({ viewport: DESKTOP });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
	});

	test('root container uses h-safe-screen class', async ({ page }) => {
		const rootContainer = page.locator('.h-safe-screen').first();
		await expect(rootContainer).toBeAttached();
		const classes = await rootContainer.getAttribute('class');
		expect(classes).toContain('h-safe-screen');
	});

	test('bottom tab bar is hidden at desktop width', async ({ page }) => {
		// At 1280px (>768px md breakpoint) BottomTabBar is hidden via md:hidden
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await expect(bottomTabBar).not.toBeVisible();
	});

	test('main content area has 0px computed padding-bottom', async ({ page }) => {
		const paddingBottom = await page.evaluate(() => {
			const el = document.querySelector('.pb-bottom-bar');
			if (!el) return null;
			return getComputedStyle(el).paddingBottom;
		});

		expect(paddingBottom).not.toBeNull();
		expect(paddingBottom).toBe('0px');
	});
});
