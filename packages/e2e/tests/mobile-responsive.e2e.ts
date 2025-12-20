import { test, expect, devices } from '@playwright/test';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';

/**
 * Mobile Responsiveness E2E Tests
 *
 * Tests mobile-specific behaviors and responsive layout:
 * - Mobile sidebar toggle (hamburger menu)
 * - Touch input handling
 * - Mobile Enter key behavior (newline vs send)
 * - Responsive layout at various breakpoints
 *
 * Uses Playwright's device emulation for realistic mobile testing
 */
test.describe('Mobile Responsiveness', () => {
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
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
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

	test('should display correctly on mobile viewport', async ({ page }) => {
		// Verify the app loads on mobile
		const heading = page.getByRole('heading', { name: 'Liuboer', exact: true }).first();
		await expect(heading).toBeVisible();

		// New Session button should still be accessible
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();
	});

	test('should have responsive sidebar behavior', async ({ page }) => {
		// On mobile, sidebar might be hidden or toggleable
		// Look for hamburger menu or sidebar toggle
		const hamburgerMenu = page.locator(
			'button[aria-label="Toggle menu"], button[aria-label="Menu"], .hamburger, [data-testid="mobile-menu"]'
		);

		// Check if hamburger exists on mobile
		const hasHamburger = await hamburgerMenu
			.first()
			.isVisible()
			.catch(() => false);

		// On mobile, either sidebar is visible or there's a toggle
		const sidebar = page.locator('nav, aside, [role="navigation"]').first();
		const sidebarVisible = await sidebar.isVisible().catch(() => false);

		// At least one navigation method should exist
		expect(hasHamburger || sidebarVisible).toBe(true);
	});

	test('should create session on mobile', async ({ page }) => {
		// Create a new session on mobile
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Verify session was created
		expect(sessionId).toBeTruthy();

		// Textarea should be visible and usable
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible();
	});

	test('should handle touch input on textarea', async ({ page }) => {
		// Create a session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Find textarea
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible();

		// Tap to focus (simulate touch)
		await textarea.tap();

		// Type some text
		await textarea.fill('Hello from mobile');

		// Verify text was entered
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('Hello from mobile');
	});

	test('should have appropriately sized touch targets', async ({ page }) => {
		// Create a session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });

		// Check button size meets minimum touch target (44x44 is recommended)
		const buttonBox = await newSessionButton.boundingBox();
		if (buttonBox) {
			// Width and height should be reasonable for touch
			expect(buttonBox.width).toBeGreaterThanOrEqual(40);
			expect(buttonBox.height).toBeGreaterThanOrEqual(40);
		}

		// Create session and check input area
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Textarea should be appropriately sized
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		const textareaBox = await textarea.boundingBox();
		if (textareaBox) {
			// Textarea should span most of the mobile width
			expect(textareaBox.width).toBeGreaterThan(200);
		}
	});

	test('should display messages correctly on narrow screen', async ({ page }) => {
		// Create a session and send a message
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Test message on mobile');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Check that messages don't overflow horizontally
		const messageContainer = page.locator('[data-role="assistant"]').first();
		const containerBox = await messageContainer.boundingBox();
		if (containerBox) {
			// Message should fit within viewport width
			expect(containerBox.width).toBeLessThanOrEqual(390);
		}
	});
});

test.describe('Tablet Responsiveness', () => {
	let sessionId: string | null = null;

	// Use iPad viewport for tablet tests
	test.use({
		viewport: { width: 768, height: 1024 },
		hasTouch: true,
		isMobile: false,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
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

	test('should display sidebar on tablet', async ({ page }) => {
		// On tablet, sidebar should typically be visible
		const sidebar = page.locator('nav, aside, [role="navigation"]').first();

		// Either sidebar is visible or there's a way to show it
		const sidebarVisible = await sidebar.isVisible().catch(() => false);
		const toggleButton = page
			.locator('button[aria-label*="menu"], button[aria-label*="Menu"]')
			.first();
		const hasToggle = await toggleButton.isVisible().catch(() => false);

		expect(sidebarVisible || hasToggle).toBe(true);
	});

	test('should create and use session on tablet', async ({ page }) => {
		// Create a session on tablet
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Send a message
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Hello from tablet');
		await page.keyboard.press('Meta+Enter');

		// Wait for response
		await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 30000 });

		// Verify layout works correctly
		const chatArea = page.locator('main, [role="main"]').first();
		await expect(chatArea).toBeVisible();
	});
});
