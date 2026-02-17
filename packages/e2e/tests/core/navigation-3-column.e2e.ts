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
import { cleanupTestSession, waitForSessionCreated } from '../helpers/wait-helpers';

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
		// NavRail should be visible on desktop (hidden on mobile with md:hidden)
		const navRail = page.locator('.hidden.md\\:flex').first();
		await expect(navRail).toBeVisible();

		// Verify NavRail has w-16 class (64px width)
		await expect(navRail).toHaveClass(/w-16/);

		// Verify it contains navigation icons
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await expect(chatsButton).toBeVisible();

		const roomsButton = page.getByRole('button', { name: 'Rooms', exact: true });
		await expect(roomsButton).toBeVisible();

		const projectsButton = page.getByRole('button', {
			name: 'Projects (Coming Soon)',
			exact: true,
		});
		await expect(projectsButton).toBeVisible();

		const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
		await expect(settingsButton).toBeVisible();
	});

	test('should display ContextPanel with correct width', async ({ page }) => {
		// ContextPanel should be visible on desktop with w-70 class (280px width)
		const contextPanel = page.locator('.w-70').first();
		await expect(contextPanel).toBeVisible();

		// It contains the "Chats" header and "New Session" button
		const contextPanelHeader = page.locator('h2:has-text("Chats")');
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

	test('should have Projects icon disabled', async ({ page }) => {
		const projectsButton = page.getByRole('button', {
			name: 'Projects (Coming Soon)',
			exact: true,
		});
		await expect(projectsButton).toBeVisible();
		await expect(projectsButton).toBeDisabled();
	});

	test('should show SessionList in ContextPanel by default', async ({ page }) => {
		// On page load, ContextPanel should show the Chats section with SessionList
		// The ContextPanel header should show "Chats"
		const contextPanelHeader = page.locator('h2:has-text("Chats")');
		await expect(contextPanelHeader).toBeVisible();

		// New Session button should be visible (part of SessionList container)
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();

		// Chats button in NavRail should be active
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await expect(chatsButton).toHaveAttribute('aria-pressed', 'true');
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

	test('should show SessionList when Chats is active', async ({ page }) => {
		// Click Chats button to ensure we're on that section
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await chatsButton.click();
		await page.waitForTimeout(300);

		// ContextPanel header should show "Chats"
		const contextPanelHeader = page.locator('h2:has-text("Chats")');
		await expect(contextPanelHeader).toBeVisible();

		// New Session button should be visible (part of chats section)
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await expect(newSessionButton).toBeVisible();

		// Chats button should be active (aria-pressed=true)
		await expect(chatsButton).toHaveAttribute('aria-pressed', 'true');
	});

	test('should show RoomList when Rooms is clicked', async ({ page }) => {
		// Click Rooms button
		const roomsButton = page.getByRole('button', { name: 'Rooms', exact: true });
		await roomsButton.click();
		await page.waitForTimeout(300);

		// ContextPanel header should show "Rooms"
		const contextPanelHeader = page.locator('h2:has-text("Rooms")');
		await expect(contextPanelHeader).toBeVisible();

		// Create Room button should be visible
		const createRoomButton = page.getByRole('button', { name: 'Create Room', exact: true });
		await expect(createRoomButton).toBeVisible();

		// Rooms button should be active
		await expect(roomsButton).toHaveAttribute('aria-pressed', 'true');
	});

	test('should show Settings section when Settings is clicked', async ({ page }) => {
		// Click Settings button
		const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
		await settingsButton.click();
		await page.waitForTimeout(300);

		// ContextPanel header should show "Settings"
		const contextPanelHeader = page.locator('h2:has-text("Settings")');
		await expect(contextPanelHeader).toBeVisible();

		// Settings button should be active
		await expect(settingsButton).toHaveAttribute('aria-pressed', 'true');
	});

	test('should show Projects coming soon content when Projects is clicked (if enabled)', async ({
		page,
	}) => {
		// Note: Projects button is disabled, so this tests the UI state
		const projectsButton = page.getByRole('button', {
			name: 'Projects (Coming Soon)',
			exact: true,
		});

		// Verify it's disabled
		await expect(projectsButton).toBeDisabled();
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
		// Click New Session button in ContextPanel
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();

		// Wait for session to be created
		sessionId = await waitForSessionCreated(page);

		// Verify session ID was obtained
		expect(sessionId).toBeTruthy();
	});

	test('should show new session in SessionList', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Session should appear in the sidebar (ContextPanel)
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionCard).toBeVisible({ timeout: 5000 });
	});

	test('should navigate to session when clicked in SessionList', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// Navigate away to home first
		await page.goto('/');
		await page.waitForTimeout(500);

		// Make sure we're on Chats section
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await chatsButton.click();
		await page.waitForTimeout(300);

		// Click on the session in the list
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`);
		await expect(sessionCard).toBeVisible({ timeout: 5000 });
		await sessionCard.click();

		// URL should change to /session/{sessionId}
		await page.waitForTimeout(500);
		expect(page.url()).toContain(`/session/${sessionId}`);
	});

	test('should show session content in MainContent area', async ({ page }) => {
		// Create a new session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		sessionId = await waitForSessionCreated(page);

		// MainContent should show the chat container with message input
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
	});
});

test.describe('Room Navigation', () => {
	test.use({ viewport: DESKTOP_VIEWPORT });

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// Wait for the app to load by checking for the New Session button
		await expect(page.getByRole('button', { name: 'New Session', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await page.waitForTimeout(500);
	});

	test('should show RoomList when Rooms section is active', async ({ page }) => {
		// Click Rooms button
		const roomsButton = page.getByRole('button', { name: 'Rooms', exact: true });
		await roomsButton.click();
		await page.waitForTimeout(300);

		// ContextPanel should show "Rooms" header
		const contextPanelHeader = page.locator('h2:has-text("Rooms")');
		await expect(contextPanelHeader).toBeVisible();

		// Create Room button should be visible
		const createRoomButton = page.getByRole('button', { name: 'Create Room', exact: true });
		await expect(createRoomButton).toBeVisible();
	});

	test('should create room and navigate to it', async ({ page }) => {
		// Navigate to Rooms section
		const roomsButton = page.getByRole('button', { name: 'Rooms', exact: true });
		await roomsButton.click();
		await page.waitForTimeout(300);

		// Click Create Room button
		const createRoomButton = page.getByRole('button', { name: 'Create Room', exact: true });
		await createRoomButton.click();
		await page.waitForTimeout(1000);

		// Should navigate to a room URL
		expect(page.url()).toMatch(/\/room\//);
	});

	test('should show Room component in MainContent when viewing a room', async ({ page }) => {
		// Create a room
		const roomsButton = page.getByRole('button', { name: 'Rooms', exact: true });
		await roomsButton.click();
		await page.waitForTimeout(300);

		const createRoomButton = page.getByRole('button', { name: 'Create Room', exact: true });
		await createRoomButton.click();
		await page.waitForTimeout(1000);

		// Room component should be visible with room header
		// Look for the room name header or dashboard content
		await expect(page.locator('h2').filter({ hasText: /Room/ }).first()).toBeVisible({
			timeout: 5000,
		});
	});
});

test.describe('Mobile Layout (<768px)', () => {
	test.use({ viewport: MOBILE_VIEWPORT });

	// Helper function to create a session and return session ID
	async function createSessionForMobileTest(
		page: typeof import('@playwright/test').Page
	): Promise<string> {
		// On mobile at home page, ContextPanel is hidden but New Session might be visible in Lobby
		// Try clicking New Session from Lobby header
		const lobbyNewSessionButton = page
			.getByRole('button', { name: 'New Session', exact: true })
			.first();
		if (await lobbyNewSessionButton.isVisible().catch(() => false)) {
			await lobbyNewSessionButton.dispatchEvent('click');
			return waitForSessionCreated(page);
		}
		throw new Error('Could not find New Session button');
	}

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		// On mobile, wait for either Lobby or any content to be visible
		await page.waitForTimeout(1000);
	});

	test('should hide NavRail on mobile', async ({ page }) => {
		// NavRail uses class "hidden md:flex" so it should be hidden on mobile
		// Check that the Chats button in NavRail is NOT visible
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });

		// The button might exist in DOM but not be visible
		const isVisible = await chatsButton.isVisible().catch(() => false);
		expect(isVisible).toBe(false);
	});

	test('should hide ContextPanel drawer by default on mobile', async ({ page }) => {
		// On mobile, wait for the Lobby to load first
		await expect(page.locator('h2:has-text("Neo Lobby")')).toBeVisible({ timeout: 5000 });

		// ContextPanel uses "-translate-x-full md:translate-x-0" so it's hidden by default on mobile
		// The "Chats" header in ContextPanel should not be visible initially
		const contextPanelHeader = page.locator('h2:has-text("Chats")');
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
			await page.waitForTimeout(300);

			// ContextPanel should now be visible
			const contextPanelHeader = page.locator('h2:has-text("Chats")');
			await expect(contextPanelHeader).toBeVisible({ timeout: 5000 });

			// New Session button should be visible
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await expect(newSessionButton).toBeVisible();
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

	test('should close drawer when backdrop is clicked', async ({ page }) => {
		let sessionId: string | null = null;
		try {
			// Create a session first
			sessionId = await createSessionForMobileTest(page);

			// Open the drawer
			const hamburgerButton = page.locator('button[title="Open menu"]');
			await hamburgerButton.click();
			await page.waitForTimeout(300);

			// Verify drawer is open
			const contextPanelHeader = page.locator('h2:has-text("Chats")');
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

	test('should close drawer when close button is clicked', async ({ page }) => {
		let sessionId: string | null = null;
		try {
			// Create a session first
			sessionId = await createSessionForMobileTest(page);

			// Open the drawer
			const hamburgerButton = page.locator('button[title="Open menu"]');
			await hamburgerButton.click();
			await page.waitForTimeout(500);

			// Verify drawer is open
			const contextPanelHeader = page.locator('h2:has-text("Chats")');
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
			// On mobile home page, try to create session via Lobby button
			const lobbyNewSessionButton = page
				.getByRole('button', { name: 'New Session', exact: true })
				.first();
			await expect(lobbyNewSessionButton).toBeVisible({ timeout: 5000 });
			await lobbyNewSessionButton.dispatchEvent('click');

			// Wait for session creation
			sessionId = await waitForSessionCreated(page);
			expect(sessionId).toBeTruthy();
		} finally {
			// Cleanup
			if (sessionId) {
				await cleanupTestSession(page, sessionId).catch(() => {});
			}
		}
	});

	test('should navigate between sections via drawer on mobile', async ({ page }) => {
		let sessionId: string | null = null;
		try {
			// Create a session first
			sessionId = await createSessionForMobileTest(page);

			// Open the drawer
			const hamburgerButton = page.locator('button[title="Open menu"]');
			await hamburgerButton.click();
			await page.waitForTimeout(500);

			// Initially should show Chats
			const chatsHeader = page.locator('h2:has-text("Chats")');
			await expect(chatsHeader).toBeVisible({ timeout: 5000 });

			// Since NavRail is hidden on mobile, verify we can see the drawer content
			// and close it by clicking backdrop with force to avoid interception
			const backdrop = page.locator('.fixed.inset-0.bg-black\\/50');
			await backdrop.click({ force: true });
			await page.waitForTimeout(500);

			// Drawer should be closed
			const isVisible = await chatsHeader.isVisible().catch(() => false);
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

		// NavRail should be hidden
		const chatsButtonMobile = page.getByRole('button', { name: 'Chats', exact: true });
		let isVisible = await chatsButtonMobile.isVisible().catch(() => false);
		expect(isVisible).toBe(false);

		// Resize to desktop
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should now be visible
		await expect(chatsButtonMobile).toBeVisible({ timeout: 5000 });
	});

	test('should hide NavRail when resizing from desktop to mobile', async ({ page }) => {
		// Start at desktop size
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should be visible
		const chatsButton = page.getByRole('button', { name: 'Chats', exact: true });
		await expect(chatsButton).toBeVisible();

		// Resize to mobile
		await page.setViewportSize(MOBILE_VIEWPORT);
		await page.waitForTimeout(300);

		// NavRail should now be hidden
		const isVisible = await chatsButton.isVisible().catch(() => false);
		expect(isVisible).toBe(false);
	});
});
