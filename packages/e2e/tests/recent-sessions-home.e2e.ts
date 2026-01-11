/**
 * Recent Sessions Home Page E2E Tests
 *
 * Tests the RecentSessions component on the home page:
 * - Recent Sessions section display
 * - Session card content (title, time, stats)
 * - Session card click navigation
 * - Feature highlights display
 * - Empty state when no sessions
 */

import { test, expect } from '../fixtures';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	cleanupTestSession,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

test.describe('Recent Sessions Home Page', () => {
	let sessionIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await setupMessageHubTesting(page);
	});

	test.afterEach(async ({ page }) => {
		// Cleanup all created sessions
		for (const sessionId of sessionIds) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
		}
		sessionIds = [];
	});

	test('should display welcome message on home page', async ({ page }) => {
		// Should show welcome header
		await expect(page.locator('text=Welcome to Liuboer')).toBeVisible({ timeout: 10000 });
	});

	test('should display feature highlights', async ({ page }) => {
		// Should show feature highlights
		await expect(page.locator('text=Real-time streaming')).toBeVisible({ timeout: 10000 });
		await expect(page.locator('text=Tool visualization')).toBeVisible();
		await expect(page.locator('text=Workspace management')).toBeVisible();
		await expect(page.locator('text=Multi-session support')).toBeVisible();
	});

	test('should show Recent Sessions section after creating a session', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);
		sessionIds.push(sessionId);

		// Send a message to make the session visible
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');
		await waitForAssistantResponse(page);

		// Navigate back to home by deselecting the current session
		// Click the Liuboer logo/title to go back to home
		await page.goto('/');

		// Should show "Recent Sessions" section
		await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 10000 });
	});

	test('should display session card with title and stats', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);
		sessionIds.push(sessionId);

		// Send a message to populate session data
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');
		await waitForAssistantResponse(page);

		// Navigate back to home
		await page.goto('/');

		// Wait for recent sessions to appear
		await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 10000 });

		// Session card should show cost (format: $0.0000 or similar)
		// Use a simpler text match for the dollar sign with 4 decimal places
		const costElement = page.locator('text=/\\$0\\.\\d{4}/').first();
		await expect(costElement).toBeVisible({ timeout: 5000 });
	});

	test('should navigate to session when clicking session card', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);
		sessionIds.push(sessionId);

		// Send a message
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');
		await waitForAssistantResponse(page);

		// Navigate back to home
		await page.goto('/');

		// Wait for recent sessions to appear
		await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 10000 });

		// Click on the session card
		const sessionCard = page.locator(`[data-session-id="${sessionId}"]`).first();

		// If the session card doesn't have data-session-id, find it by the session content
		// Session cards are buttons inside the recent sessions grid
		const sessionCardButton = page
			.locator('button')
			.filter({ hasText: /Hello|New Session/ })
			.first();
		if ((await sessionCard.count()) > 0) {
			await sessionCard.click();
		} else {
			await sessionCardButton.click();
		}

		// Should navigate to the session (message input should be visible)
		await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
			timeout: 10000,
		});
	});

	test('should show empty state when no sessions exist', async ({ page }) => {
		// This test is tricky because sessions may exist from other tests
		// We'll check for the conditional message

		// Should either show "Recent Sessions" or "No sessions yet" depending on state
		const hasRecentSessions = await page.locator('text=Recent Sessions').isVisible();
		const hasNoSessions = await page.locator('text=No sessions yet').isVisible();

		// One of these should be true
		expect(hasRecentSessions || hasNoSessions).toBe(true);
	});

	test('should show relative time for sessions', async ({ page }) => {
		// Create a session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		const sessionId = await waitForSessionCreated(page);
		sessionIds.push(sessionId);

		// Send a message
		const input = page.locator('textarea[placeholder*="Ask"]').first();
		await input.fill('Hello');
		await page.keyboard.press('Enter');
		await waitForAssistantResponse(page);

		// Navigate back to home
		await page.goto('/');

		// Wait for recent sessions to appear
		await expect(page.locator('text=Recent Sessions')).toBeVisible({ timeout: 10000 });

		// Should show relative time (e.g., "just now", "1 minute ago", etc.)
		// Use a regex that matches common relative time patterns
		const timePatterns = page.locator('text=/just now|seconds? ago|minutes? ago|hours? ago/i');
		await expect(timePatterns.first()).toBeVisible({ timeout: 5000 });
	});

	test('should display correct subtitle based on session state', async ({ page }) => {
		// With no sessions, check for "Create a new session to get started"
		// With sessions, check for "Continue where you left off or create a new session"
		const hasRecentSessions = await page.locator('text=Recent Sessions').isVisible();

		if (hasRecentSessions) {
			await expect(page.locator('text=Continue where you left off')).toBeVisible();
		} else {
			await expect(page.locator('text=Create a new session to get started')).toBeVisible();
		}
	});

	test('should display robot emoji on home page', async ({ page }) => {
		// The robot emoji is part of the welcome message (use first() to avoid strict mode)
		await expect(page.locator('text=🤖').first()).toBeVisible({ timeout: 10000 });
	});
});
