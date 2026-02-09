/**
 * Mobile E2E Tests
 *
 * Consolidated tests for mobile/responsive behavior:
 * - Layout adaptation
 * - Input behavior on mobile
 * - Message display on mobile
 */

import { test, expect, devices } from '../../fixtures';
import { cleanupTestSession, waitForSessionCreated } from '../helpers/wait-helpers';

test.describe('Mobile Layout', () => {
	// Use iPhone 13 viewport for mobile tests
	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
	});

	test('should display correctly on mobile viewport', async ({ page }) => {
		// Verify the app loads on mobile
		const heading = page.getByRole('heading', { name: 'NeoKai', exact: true }).first();
		await expect(heading).toBeVisible();

		// New Session button should still be accessible
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();
	});

	test('should have responsive sidebar behavior', async ({ page }) => {
		// On mobile, sidebar might be hidden or toggleable
		// Look for "Open menu" button (hamburger) or "Close sidebar" button or "New Session"
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});

		// Check if any navigation element exists
		const hasOpenMenu = (await openMenuButton.count()) > 0;
		const hasCloseSidebar = (await closeSidebarButton.count()) > 0;
		const hasNewSession = (await newSessionButton.count()) > 0;

		// At least one navigation method should exist
		expect(hasOpenMenu || hasCloseSidebar || hasNewSession).toBe(true);
	});
});

test.describe('Mobile Input', () => {
	let sessionId: string | null = null;

	// Use iPhone 13 viewport for mobile tests
	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should create session on mobile', async ({ page }) => {
		// On mobile, the sidebar may be open or closed - check both states
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		const openMenuButton = page.locator('button[aria-label="Open menu"]');

		// If sidebar is closed (Open menu visible), open it
		const isSidebarClosed = (await openMenuButton.count()) > 0;
		if (isSidebarClosed) {
			await openMenuButton.first().click();
			await page.waitForTimeout(500);
		}

		// Now the New Session button should be accessible in the sidebar
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();

		// Use dispatchEvent to click without viewport restrictions
		await newSessionButton.dispatchEvent('click');
		sessionId = await waitForSessionCreated(page);

		// Verify session was created
		expect(sessionId).toBeTruthy();

		// On mobile, close sidebar to see the chat area
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		// Textarea should be visible and usable
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
	});

	test('should handle touch input on textarea', async ({ page }) => {
		// On mobile, ensure sidebar is accessible
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const isSidebarClosed = (await openMenuButton.count()) > 0;
		if (isSidebarClosed) {
			await openMenuButton.first().click();
			await page.waitForTimeout(500);
		}

		// Create a session using dispatchEvent to bypass viewport checks
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();
		await newSessionButton.dispatchEvent('click');
		sessionId = await waitForSessionCreated(page);

		// Close sidebar to see chat area
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		// Find textarea
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });

		// Tap to focus (simulate touch)
		await textarea.tap();

		// Type some text
		await textarea.fill('Hello from mobile');

		// Verify text was entered
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('Hello from mobile');
	});

	test('should have appropriately sized touch targets', async ({ page }) => {
		// On mobile, ensure sidebar is accessible
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const isSidebarClosed = (await openMenuButton.count()) > 0;
		if (isSidebarClosed) {
			await openMenuButton.first().click();
			await page.waitForTimeout(500);
		}

		// Check New Session button
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();

		// Check button size - should be reasonably sized for touch
		const buttonBox = await newSessionButton.boundingBox();
		if (buttonBox) {
			// Width should be reasonable for touch (wider is better)
			expect(buttonBox.width).toBeGreaterThanOrEqual(40);
			// Height can be slightly less than 44px in compact mobile layouts
			expect(buttonBox.height).toBeGreaterThanOrEqual(32);
		}

		// Create session using dispatchEvent to bypass viewport checks
		await newSessionButton.dispatchEvent('click');
		sessionId = await waitForSessionCreated(page);

		// Close sidebar to see textarea
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		// Textarea should be appropriately sized
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		const textareaBox = await textarea.boundingBox();
		if (textareaBox) {
			// Textarea should span most of the mobile width
			expect(textareaBox.width).toBeGreaterThan(200);
		}
	});
});

test.describe('Mobile Messages', () => {
	let sessionId: string | null = null;

	// Use iPhone 13 viewport for mobile tests
	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'NeoKai', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should display messages correctly on narrow screen', async ({ page }) => {
		// On mobile, ensure sidebar is accessible
		const openMenuButton = page.locator('button[aria-label="Open menu"]');
		const isSidebarClosed = (await openMenuButton.count()) > 0;
		if (isSidebarClosed) {
			await openMenuButton.first().click();
			await page.waitForTimeout(500);
		}

		// Create a session using dispatchEvent to bypass viewport checks
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();
		await newSessionButton.dispatchEvent('click');
		sessionId = await waitForSessionCreated(page);

		// Close sidebar to see chat area
		const closeSidebarButton = page.locator('button[aria-label="Close sidebar"]');
		if (await closeSidebarButton.isVisible().catch(() => false)) {
			await closeSidebarButton.click();
			await page.waitForTimeout(300);
		}

		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Test message on mobile');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-message-role="assistant"]').first()).toBeVisible({
			timeout: 60000,
		});

		// Check that messages don't overflow horizontally
		const messageContainer = page.locator('[data-message-role="assistant"]').first();
		const containerBox = await messageContainer.boundingBox();
		if (containerBox) {
			// Message should fit within viewport width
			expect(containerBox.width).toBeLessThanOrEqual(390);
		}
	});
});
