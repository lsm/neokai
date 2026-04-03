/**
 * Tablet Responsiveness E2E Tests
 *
 * Tests for tablet-specific responsive behavior:
 * - Sidebar display on tablet
 * - Session creation and usage on tablet
 */

import { test, expect } from '../../fixtures';
import {
	cleanupTestSession,
	createSessionViaUI,
	waitForAssistantResponse,
	waitForWebSocketConnected,
} from '../helpers/wait-helpers';
import { closeMobilePanel, openMobilePanel } from '../helpers/mobile-helpers';

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
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
		await waitForWebSocketConnected(page);
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
		// On tablet, check for sidebar controls
		const closePanelButton = page.locator('button[title="Close panel"]');
		const menuButton = page.locator('button[aria-label="Open navigation menu"]');
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});

		const hasClosePanel = await closePanelButton.isVisible().catch(() => false);
		const hasMenuButton = await menuButton.isVisible().catch(() => false);
		const hasNewSession = await newSessionButton.isVisible().catch(() => false);

		// At least one navigation method should exist
		expect(hasClosePanel || hasMenuButton || hasNewSession).toBe(true);
	});

	test('should create and use session on tablet', async ({ page }) => {
		// Open the mobile panel to access the New Session button
		await openMobilePanel(page);

		// Create a session on tablet
		sessionId = await createSessionViaUI(page);

		// Close panel to see the chat area
		await closeMobilePanel(page);

		// Type a message to verify input works on tablet
		// Use specific selector to avoid matching Neo panel textbox
		const textarea = page.locator('textarea[placeholder*="Ask"]:not([placeholder*="Neo"])').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Hello from tablet');

		// Verify text was entered correctly
		const inputValue = await textarea.inputValue();
		expect(inputValue).toBe('Hello from tablet');
	});
});
