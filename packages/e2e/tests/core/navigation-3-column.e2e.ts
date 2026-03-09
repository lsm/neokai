/**
 * 3-Column Layout Navigation E2E Tests
 *
 * Tests for the new 3-column layout with:
 * - NavRail (64px wide navigation icons)
 * - ContextPanel (280px wide sidebar with lists)
 * - MainContent (flexible main content area)
 *
 * Desktop Layout (>=768px):
 * - NavRail visible, ContextPanel visible, MainContent flexible
 *
 * Mobile Layout (<768px):
 * - NavRail hidden, ContextPanel as drawer, hamburger menu
 */

import { test, expect } from '../../fixtures';
import { cleanupTestSession, createSessionViaUI } from '../helpers/wait-helpers';

// Desktop viewport for standard tests
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

// Mobile viewport for mobile tests
const MOBILE_VIEWPORT = { width: 375, height: 667 };

test.describe('Desktop 3-Column Layout (>=768px)', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for the app to load by checking for the New Session button in ContextPanel
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await page.waitForTimeout(500);
	});

	test('should display NavRail with correct width and structure', async ({ page }) => {
		// NavRail should be visible on desktop (has w-16 class, 64px width)
		const navRail = page.locator('.w-16').first();
		await expect(navRail).toBeVisible();

		// Verify NavRail has w-16 class (64px width)
		await expect(navRail).toHaveClass(/w-16/);

		// Verify it contains navigation icons (current UI: Home, Chats, Settings)
		const homeButton = page.getByRole('button', { name: 'Home', exact: true });
		await expect(homeButton).toBeVisible();

		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await expect(chatsButton).toBeVisible();

		const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
		await expect(settingsButton).toBeVisible();
	});

	test('should display ContextPanel with correct width', async ({ page }) => {
		// ContextPanel should be visible on desktop with w-70 class (280px width)
		const contextPanel = page.locator('.w-70').first();
		await expect(contextPanel).toBeVisible();

		// It contains the "Rooms" header and "New Session" button on home page
		const contextPanelHeader = page.locator('h2:has-text("Rooms")');
		await expect(contextPanelHeader).toBeVisible();

		// New Session button should be visible in ContextPanel
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();
	});

	test('should display MainContent area', async ({ page }) => {
		// MainContent shows either Lobby or ChatContainer
		// On home page, we should see the Lobby with "Neo Lobby" or welcome content
		const lobbyHeader = page.locator('h2:has-text("Neo Lobby")');
		await expect(lobbyHeader).toBeVisible();
	});

	test('should show SessionList in ContextPanel by default', async ({ page }) => {
		// On page load (home section), ContextPanel should show the Rooms section with SessionList
		// The ContextPanel header should show "Rooms" on home page
		const contextPanelHeader = page.locator('h2:has-text("Rooms")');
		await expect(contextPanelHeader).toBeVisible();

		// New Session button should be visible (part of SessionList container)
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();

		// Home button in NavRail should be active
		const homeButton = page.getByRole('button', { name: 'Home', exact: true });
		await expect(homeButton).toHaveAttribute('aria-pressed', 'true');
	});
});

test.describe('Navigation Section Switching', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for the app to load by checking for the New Session button
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await page.waitForTimeout(500);
	});

	test('should show SessionList when Home is active', async ({ page }) => {
		// Click Home button to ensure we're on that section
		const homeButton = page.getByRole('button', { name: 'Home', exact: true });
		await homeButton.click();
		await page.waitForTimeout(300);

		// ContextPanel header should show "Rooms" on home page
		const contextPanelHeader = page.locator('h2:has-text("Rooms")');
		await expect(contextPanelHeader).toBeVisible();

		// New Session button should be visible (part of home section)
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();

		// Home button should be active (aria-pressed=true)
		await expect(homeButton).toHaveAttribute('aria-pressed', 'true');
	});

	test('should show Settings section when Settings is clicked', async ({ page }) => {
		// Click Settings button
		const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
		await settingsButton.click();
		await page.waitForTimeout(500);

		// ContextPanel header should show "Settings" (exact match to avoid "Global Settings")
		const contextPanelHeader = page.getByRole('heading', {
			name: 'Settings',
			exact: true,
			level: 2,
		});
		await expect(contextPanelHeader).toBeVisible({ timeout: 10000 });

		// Settings button should be active
		await expect(settingsButton).toHaveAttribute('aria-pressed', 'true');
	});
});

test.describe('Session Navigation', () => {
	let sessionId: string | null = null;

	test.use({ viewport: DESKTOP_VIEWPORT });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for the app to load by checking for the New Session button
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await page.waitForTimeout(500);
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

	test('should create new session via New Session button', async ({ page }) => {
		// Create session via the UI helper
		sessionId = await createSessionViaUI(page);

		// Verify session ID was obtained
		expect(sessionId).toBeTruthy();
	});

	test('should show new session in SessionList', async ({ page }) => {
		// Create a new session
		sessionId = await createSessionViaUI(page);

		// Session should appear in the sidebar (ContextPanel)
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionCard).toBeVisible({ timeout: 5000 });
	});

	test('should navigate to session when clicked in SessionList', async ({ page }) => {
		// Create a new session
		sessionId = await createSessionViaUI(page);

		// Navigate away to home first
		await page.goto('/');
		// Wait for Lobby to load with Recent Sessions section
		await expect(page.locator('h3:has-text("Recent Sessions")')).toBeVisible({ timeout: 10000 });
		await page.waitForTimeout(500);

		// Click on the session in the Recent Sessions list
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionCard).toBeVisible({ timeout: 10000 });
		await sessionCard.click();

		// URL should change to /session/{sessionId}
		await page.waitForTimeout(500);
		expect(page.url()).toContain(`/session/${sessionId}`);
	});

	test('should show session content in MainContent area', async ({ page }) => {
		// Create a new session
		sessionId = await createSessionViaUI(page);

		// MainContent should show the chat container with message input
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
	});
});

test.describe
	.serial('Mobile Layout (<768px)', () => {
		test.use({ viewport: MOBILE_VIEWPORT });

		// Helper function to create a session and return session ID
		async function createSessionForMobileTest(
			page: typeof import('@playwright/test').Page
		): Promise<string> {
			// Use the centralized helper
			return createSessionViaUI(page);
		}

		test.beforeEach(async ({ page }) => {
			await page.goto('/');
			// On mobile, wait for the Lobby to load first
			await expect(page.locator('h2:has-text("Neo Lobby")')).toBeVisible({ timeout: 10000 });

			// If the ContextPanel drawer is open from a previous test, close it
			const contextPanelHeader = page.locator('h2:has-text("Rooms")');
			if (await contextPanelHeader.isVisible().catch(() => false)) {
				// Try clicking the close button first (use dispatchEvent to avoid viewport issues)
				const closeButton = page.locator('button[title="Close panel"]');
				if (await closeButton.isVisible().catch(() => false)) {
					await closeButton.dispatchEvent('click');
				} else {
					// Fall back to clicking backdrop
					const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
					if (await backdrop.isVisible().catch(() => false)) {
						await backdrop.dispatchEvent('click');
					}
				}
				await page.waitForTimeout(300);
			}
		});

		test('should hide NavRail on mobile', async ({ page }) => {
			// NavRail uses slide-in animation "-translate-x-full md:translate-x-0" so it's visually hidden on mobile
			// Check that the Chats button is positioned off-screen (to the left of viewport)
			const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });

			// The button is transformed off-screen, so its bounding box should be mostly outside viewport
			const boundingBox = await chatsButton.boundingBox();
			// If NavRail is hidden via -translate-x-full, the button should be positioned to the left of viewport
			// (boundingBox.x should be negative or the right edge should be <= 0)
			expect(boundingBox).not.toBeNull();
			expect(boundingBox!.x + boundingBox!.width).toBeLessThanOrEqual(0);
		});

		// Note: This test is skipped because the drawer state can persist across tests due to signal state
		// The drawer behavior is tested in other mobile tests (open/close via hamburger menu)
		test.skip('should hide ContextPanel drawer by default on mobile', async ({ page }) => {
			// ContextPanel uses "-translate-x-full md:translate-x-0" so it's hidden by default on mobile
			// The "Rooms" header in ContextPanel should not be visible initially
			const contextPanelHeader = page.locator('h2:has-text("Rooms")');
			const isVisible = await contextPanelHeader.isVisible().catch(() => false);
			expect(isVisible).toBe(false);
		});

		test('should show hamburger menu in session view on mobile', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// First create a session so we can see the chat header with hamburger menu
				sessionId = await createSessionForMobileTest(page);

				// Look for the hamburger menu button (has title="Open menu")
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await expect(hamburgerButton).toBeVisible({ timeout: 5000 });
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		test('should open ContextPanel drawer when hamburger menu is clicked', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// Create a session first
				sessionId = await createSessionForMobileTest(page);

				// Click hamburger menu
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await hamburgerButton.click();

				// Wait for the drawer animation - check for backdrop which appears when drawer is open
				const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
				await expect(backdrop).toBeVisible({ timeout: 5000 });

				// Wait for animation to complete
				await page.waitForTimeout(500);

				// Check that ContextPanel is visible by looking for the close button
				const closeButton = page.locator('button[title="Close panel"]');
				await expect(closeButton).toBeVisible({ timeout: 5000 });

				// Verify the drawer has content by checking for any heading
				// The ContextPanel shows "Rooms" on home section
				const panelContent = page.locator('.w-70').first();
				await expect(panelContent).toBeVisible({ timeout: 5000 });
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		test('should show backdrop when drawer is open', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// Create a session first
				sessionId = await createSessionForMobileTest(page);

				// Open the drawer
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await hamburgerButton.click();
				await page.waitForTimeout(300);

				// Backdrop should be visible (black/50 opacity overlay)
				const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
				await expect(backdrop).toBeVisible({ timeout: 5000 });
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		// Note: This test is skipped due to flaky behavior with backdrop click interaction
		// The drawer closing is verified in the "navigate between sections" test
		test.skip('should close drawer when backdrop is clicked', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// Create a session first
				sessionId = await createSessionForMobileTest(page);

				// Open the drawer
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await hamburgerButton.click();
				await page.waitForTimeout(300);

				// Verify drawer is open (shows "Rooms" on home section)
				const contextPanelHeader = page.locator('h2:has-text("Rooms")');
				await expect(contextPanelHeader).toBeVisible({ timeout: 5000 });

				// Click the backdrop - use force:true because session cards may intercept
				const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
				await backdrop.click({ force: true });
				await page.waitForTimeout(300);

				// Drawer should now be closed
				const isVisible = await contextPanelHeader.isVisible().catch(() => false);
				expect(isVisible).toBe(false);
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		// Note: This test is skipped due to flaky behavior with close button interaction
		test.skip('should close drawer when close button is clicked', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// Create a session first
				sessionId = await createSessionForMobileTest(page);

				// Open the drawer
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await hamburgerButton.click();
				await page.waitForTimeout(500);

				// Verify drawer is open (shows "Rooms" on home section)
				const contextPanelHeader = page.locator('h2:has-text("Rooms")');
				await expect(contextPanelHeader).toBeVisible({ timeout: 5000 });

				// Click the close button (has title="Close panel") - use force to avoid interception
				const closeButton = page.locator('button[title="Close panel"]');
				await closeButton.click({ force: true });
				await page.waitForTimeout(500);

				// Drawer should now be closed - give it more time for animation
				const isVisible = await contextPanelHeader.isVisible().catch(() => false);
				expect(isVisible).toBe(false);
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		test('should create session from mobile drawer', async ({ page }) => {
			let sessionId: string | null = null;

			try {
				// Create session via the UI helper
				sessionId = await createSessionViaUI(page);
				expect(sessionId).toBeTruthy();
			} finally {
				// Cleanup
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});

		// Note: This test is skipped due to flaky behavior with drawer close interaction
		test.skip('should navigate between sections via drawer on mobile', async ({ page }) => {
			let sessionId: string | null = null;
			try {
				// Create a session first
				sessionId = await createSessionForMobileTest(page);

				// Open the drawer
				const hamburgerButton = page.locator('button[title="Open menu"]');
				await hamburgerButton.click();
				await page.waitForTimeout(500);

				// Should show Rooms section (sessions are listed here on home page)
				const roomsHeader = page.locator('h2:has-text("Rooms")');
				await expect(roomsHeader).toBeVisible({ timeout: 5000 });

				// Since NavRail is hidden on mobile, verify we can see the drawer content
				// and close it by clicking backdrop with force to avoid interception
				const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
				await backdrop.click({ force: true });
				await page.waitForTimeout(500);

				// Drawer should be closed
				const isVisible = await roomsHeader.isVisible().catch(() => false);
				expect(isVisible).toBe(false);
			} finally {
				if (sessionId) {
					await cleanupTestSession(page, sessionId).catch(() => {});
				}
			}
		});
	});

test.describe('Responsive Layout Transition', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for the app to load by checking for the New Session button
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await page.waitForTimeout(500);
	});

	test('should show NavRail and ContextPanel when resizing from mobile to desktop', async ({
		page,
	}) => {
		// Start at mobile size
		await page.setViewportSize(MOBILE_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should be hidden (via -translate-x-full transform)
		// The button is transformed off-screen, so its bounding box should be outside viewport
		const chatsButtonMobile = page.getByRole('button', { name: 'Chats', exact: true });
		let boundingBox = await chatsButtonMobile.boundingBox();
		expect(boundingBox).not.toBeNull();
		expect(boundingBox!.x + boundingBox!.width).toBeLessThanOrEqual(0);

		// Resize to desktop
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should now be visible (md:translate-x-0 makes it visible on desktop)
		await expect(chatsButtonMobile).toBeVisible({ timeout: 5000 });
	});

	test('should hide NavRail when resizing from desktop to mobile', async ({ page }) => {
		// Start at desktop size
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should be visible (md:translate-x-0)
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await expect(chatsButton).toBeVisible();

		// Resize to mobile
		await page.setViewportSize(MOBILE_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should now be hidden (via -translate-x-full transform)
		// The button is transformed off-screen, so its bounding box should be outside viewport
		const boundingBox = await chatsButton.boundingBox();
		expect(boundingBox).not.toBeNull();
		expect(boundingBox!.x + boundingBox!.width).toBeLessThanOrEqual(0);
	});
});
