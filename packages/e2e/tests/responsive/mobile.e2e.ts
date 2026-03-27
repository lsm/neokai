/**
 * Mobile E2E Tests
 *
 * Consolidated tests for mobile/responsive behavior:
 * - Layout adaptation
 * - Input behavior on mobile
 * - Message display on mobile
 * - Room agent navigation via bottom tab bar
 */

import { test, expect, devices } from '../../fixtures';
import {
	cleanupTestSession,
	createSessionViaUI,
	waitForAssistantResponse,
	waitForWebSocketConnected,
} from '../helpers/wait-helpers';
import { createRoom, deleteRoom } from '../helpers/room-helpers';
import { openMobilePanel, closeMobilePanel } from '../helpers/mobile-helpers';

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
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
	});

	test('should display correctly on mobile viewport', async ({ page }) => {
		// Verify the app loads on mobile
		const heading = page.getByRole('heading', { name: 'Neo Lobby' }).first();
		await expect(heading).toBeVisible();

		// New Session button should still be accessible
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();
	});

	test('should have responsive sidebar behavior', async ({ page }) => {
		// On mobile, the context panel should be toggleable via the menu button
		const menuButton = page.locator('button[aria-label="Open navigation menu"]');
		const closePanelButton = page.locator('button[title="Close panel"]');
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});

		// At least one navigation method should exist
		const hasMenuButton = (await menuButton.count()) > 0;
		const hasCloseButton = (await closePanelButton.count()) > 0;
		const hasNewSession = (await newSessionButton.count()) > 0;

		expect(hasMenuButton || hasCloseButton || hasNewSession).toBe(true);

		// If menu button exists, clicking it should open the panel
		if (hasMenuButton) {
			await openMobilePanel(page);
			await expect(newSessionButton).toBeVisible({ timeout: 5000 });
		}
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
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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
		// Open the mobile panel to access the New Session button
		await openMobilePanel(page);

		// Create session via RPC helper
		sessionId = await createSessionViaUI(page);

		// Verify session was created
		expect(sessionId).toBeTruthy();

		// Close panel to see the chat area
		await closeMobilePanel(page);

		// Textarea should be visible and usable
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
	});

	test('should handle touch input on textarea', async ({ page }) => {
		// Open the mobile panel to access the New Session button
		await openMobilePanel(page);

		// Create session via RPC helper
		sessionId = await createSessionViaUI(page);

		// Close panel to see chat area
		await closeMobilePanel(page);

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
		// Open the mobile panel to access the New Session button
		await openMobilePanel(page);

		// Check New Session button
		const newSessionButton = page.getByRole('button', {
			name: 'New Session',
			exact: true,
		});
		await expect(newSessionButton).toBeVisible();

		// Check button size - should be reasonably sized for touch
		const buttonBox = await newSessionButton.boundingBox();
		if (buttonBox) {
			// Icon-only buttons on mobile may be compact (28px+)
			expect(buttonBox.width).toBeGreaterThanOrEqual(24);
			// Height can be slightly less than 44px in compact mobile layouts
			expect(buttonBox.height).toBeGreaterThanOrEqual(24);
		}

		// Create session via RPC helper
		sessionId = await createSessionViaUI(page);

		// Close panel to see textarea
		await closeMobilePanel(page);

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
		await expect(page.getByRole('heading', { name: 'Neo Lobby' }).first()).toBeVisible();
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
		// Open the mobile panel to access the New Session button
		await openMobilePanel(page);

		// Create session via RPC helper
		sessionId = await createSessionViaUI(page);

		// Close panel to see chat area
		await closeMobilePanel(page);

		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await expect(textarea).toBeVisible({ timeout: 10000 });
		await textarea.fill('Test message on mobile');
		await page.keyboard.press('Meta+Enter');

		// Wait for response using the shared helper (90s default for CI reliability)
		await waitForAssistantResponse(page);

		// Check that messages don't overflow horizontally
		const messageContainer = page.locator('[data-message-role="assistant"]').first();
		const containerBox = await messageContainer.boundingBox();
		if (containerBox) {
			// Message should fit within viewport width
			expect(containerBox.width).toBeLessThanOrEqual(390);
		}
	});
});

test.describe('Mobile Room Agent Navigation', () => {
	let roomId = '';

	test.use({
		viewport: { width: 390, height: 844 },
		userAgent: devices['iPhone 13'].userAgent,
		hasTouch: true,
		isMobile: true,
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await waitForWebSocketConnected(page);
		roomId = await createRoom(page, 'Mobile Agent Nav Test');
	});

	test.afterEach(async ({ page }) => {
		if (roomId) {
			await deleteRoom(page, roomId);
			roomId = '';
		}
	});

	test('shows room-specific tabs (Overview + Agent) when in room context', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		// Wait for room to load
		await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Bottom tab bar should show room-specific tabs
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await expect(bottomTabBar).toBeVisible();

		// Room context tabs should be present
		await expect(bottomTabBar.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(bottomTabBar.getByRole('tab', { name: 'Agent' })).toBeVisible();

		// Global chats/rooms tabs should NOT be visible in room context
		await expect(bottomTabBar.getByRole('tab', { name: 'Chats' })).not.toBeVisible();
		await expect(bottomTabBar.getByRole('tab', { name: 'Rooms' })).not.toBeVisible();
	});

	test('Agent tab navigates to room agent URL', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Click the Agent tab in the bottom bar
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await bottomTabBar.getByRole('tab', { name: 'Agent' }).click();

		// URL should change to room agent path
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/agent$`), { timeout: 5000 });
	});

	test('Overview tab navigates back to room dashboard from agent view', async ({ page }) => {
		// Start from agent view
		await page.goto(`/room/${roomId}/agent`);
		await waitForWebSocketConnected(page);

		// Wait for agent view to load
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/agent$`), { timeout: 10000 });

		// Agent tab should be active
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		const agentTab = bottomTabBar.getByRole('tab', { name: 'Agent' });
		await expect(agentTab).toBeVisible();
		await expect(agentTab).toHaveAttribute('aria-selected', 'true');

		// Overview tab should not be active
		await expect(bottomTabBar.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'false'
		);

		// Click Overview tab to go back to room dashboard
		await bottomTabBar.getByRole('tab', { name: 'Overview' }).click();

		// URL should change back to room path
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}$`), { timeout: 5000 });
	});

	test('room-specific tabs restore to global tabs when leaving room', async ({ page }) => {
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);

		await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Verify room-specific tabs are shown
		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });
		await expect(bottomTabBar.getByRole('tab', { name: 'Agent' })).toBeVisible();

		// Click the "/" (Home) tab to navigate away from the room
		await bottomTabBar.getByRole('tab', { name: '/' }).click();

		// URL should change to home
		await expect(page).toHaveURL(/\/$/, { timeout: 5000 });

		// Now global tabs should be shown (Rooms tab visible)
		await expect(bottomTabBar.getByRole('tab', { name: 'Rooms' })).toBeVisible({ timeout: 5000 });
		await expect(bottomTabBar.getByRole('tab', { name: 'Chats' })).toBeVisible();
	});

	test('Overview tab is active on room dashboard but not on task or session sub-views', async ({
		page,
	}) => {
		// Create a task for navigation (infrastructure)
		const taskId = await page.evaluate(async (rId) => {
			const hub = window.__messageHub || window.appState?.messageHub;
			if (!hub?.request) throw new Error('MessageHub not available');
			const res = await hub.request('task.create', {
				roomId: rId,
				title: 'Mobile Nav Test Task',
				description: 'Task for mobile nav tab test',
			});
			return (res as { task: { id: string } }).task.id;
		}, roomId);

		const bottomTabBar = page.getByRole('tablist', { name: 'Main navigation' });

		// 1. Room dashboard — Overview should be active
		await page.goto(`/room/${roomId}`);
		await waitForWebSocketConnected(page);
		await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
			timeout: 10000,
		});
		await expect(bottomTabBar.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		// 2. Room task view — neither Overview nor Agent should be active
		await page.goto(`/room/${roomId}/task/${taskId}`);
		await waitForWebSocketConnected(page);
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/task/${taskId}$`), { timeout: 5000 });
		await expect(bottomTabBar.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'false'
		);
		await expect(bottomTabBar.getByRole('tab', { name: 'Agent' })).toHaveAttribute(
			'aria-selected',
			'false'
		);

		// 3. Room agent — Agent should be active, Overview not
		await page.goto(`/room/${roomId}/agent`);
		await waitForWebSocketConnected(page);
		await expect(page).toHaveURL(new RegExp(`/room/${roomId}/agent$`), { timeout: 5000 });
		await expect(bottomTabBar.getByRole('tab', { name: 'Agent' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(bottomTabBar.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'false'
		);
	});
});
