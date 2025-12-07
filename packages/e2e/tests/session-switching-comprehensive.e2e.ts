/**
 * Comprehensive Session Switching E2E Tests
 *
 * These tests specifically target the async cleanup bugs that were fixed:
 * - hub.subscribe() returns Promise<UnsubscribeFn>
 * - Cleanup functions must be awaited before being stored
 * - Rapid switching should not cause "cleanup is not a function" errors
 *
 * Coverage:
 * 1. Rapid session switching (stress test cleanup logic)
 * 2. Active state visual verification
 * 3. Cleanup function verification (no console errors)
 * 4. Session switching during agent processing
 */

import { test, expect } from '@playwright/test';
// import type { Page } from '@playwright/test';
import {
	setupMessageHubTesting,
	waitForSessionCreated,
	waitForElement,
	cleanupTestSession,
} from './helpers/wait-helpers';

test.describe('Session Switching - Comprehensive Coverage', () => {
	test('should handle rapid session switching without cleanup errors', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Track console errors (especially "cleanup is not a function")
		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') {
				consoleErrors.push(msg.text());
			}
		});

		// Create 5 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			await page.click('button:has-text("New Session")');
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			// Go back to home to create next session
			if (i < 4) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// RAPID SWITCHING - click through all sessions as fast as possible
		// This stresses the cleanup logic and tests if async subscribe() is properly awaited
		for (let iteration = 0; iteration < 3; iteration++) {
			for (const sessionId of sessionIds) {
				await page.click(`[data-session-id="${sessionId}"]`);
				// Minimal wait - just enough to trigger component mount/unmount
				await page.waitForTimeout(50);
			}
		}

		// Wait a bit for any delayed cleanup errors to surface
		await page.waitForTimeout(1000);

		// VERIFY: No "cleanup is not a function" errors
		const cleanupErrors = consoleErrors.filter(
			(err) => err.includes('cleanup is not a function') || err.includes('not a function')
		);
		expect(cleanupErrors).toHaveLength(0);

		// VERIFY: All sessions still work - click each and verify chat interface loads
		for (const sessionId of sessionIds) {
			await page.click(`[data-session-id="${sessionId}"]`);
			await expect(page.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({
				timeout: 5000,
			});
		}

		// Cleanup all sessions
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});

	test('should display correct active state styling when switching sessions', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Create 3 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			await page.click('button:has-text("New Session")');
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			if (i < 2) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// Test active state for each session
		for (const activeSessionId of sessionIds) {
			// Click the session
			await page.click(`[data-session-id="${activeSessionId}"]`);
			await page.waitForTimeout(500);

			// VERIFY: Active session has active styling
			const activeCard = page.locator(`[data-session-id="${activeSessionId}"]`);

			// Check for active indicators (based on SessionListItem.tsx):
			// - bg-dark-850 background
			// - border-l-2 border-l-blue-500 (left border)
			await expect(activeCard).toHaveClass(/bg-dark-850/);
			await expect(activeCard).toHaveClass(/border-l-blue-500/);

			// VERIFY: Other sessions do NOT have active styling
			for (const otherSessionId of sessionIds) {
				if (otherSessionId !== activeSessionId) {
					const otherCard = page.locator(`[data-session-id="${otherSessionId}"]`);

					// Should NOT have active background
					await expect(otherCard).not.toHaveClass(/bg-dark-850/);
					// Should have hover state instead
					await expect(otherCard).toHaveClass(/hover:bg-dark-900/);
				}
			}
		}

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});

	test('should properly cleanup subscriptions when switching sessions', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Get baseline subscription count
		const initialSubs = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// Create 2 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 2; i++) {
			await page.click('button:has-text("New Session")');
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			if (i < 1) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// Navigate to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count with session loaded
		const withSession1 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// Switch to session 2 - this should trigger cleanup of session 1's subscriptions
		await page.click(`[data-session-id="${sessionIds[1]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count with session 2 loaded
		const withSession2 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Subscription count should be similar (session 1 cleaned up, session 2 subscribed)
		// Allow for some variance (+/- 5) due to global subscriptions
		expect(Math.abs(withSession1 - withSession2)).toBeLessThanOrEqual(5);

		// Switch back to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await waitForElement(page, 'textarea');
		await page.waitForTimeout(1000);

		// Get subscription count again
		const backToSession1 = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Should be similar to first time we loaded session 1
		expect(Math.abs(withSession1 - backToSession1)).toBeLessThanOrEqual(5);

		// Go home - all session subscriptions should clean up
		await page.click('h1:has-text("Liuboer")');
		await page.waitForTimeout(1000);

		const backHome = await page.evaluate(() => {
			const hub = window.__messageHub;
			return hub?.subscriptions?.size || 0;
		});

		// VERIFY: Back at home, subscription count should be close to initial
		// (allowing for global subscriptions that stay active)
		expect(backHome).toBeLessThanOrEqual(initialSubs + 10);

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});

	test('should handle session switching during message processing', async ({ page }) => {
		await setupMessageHubTesting(page);

		// Create 2 sessions
		const sessionIds: string[] = [];
		for (let i = 0; i < 2; i++) {
			await page.click('button:has-text("New Session")');
			const sessionId = await waitForSessionCreated(page);
			sessionIds.push(sessionId);

			if (i < 1) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// Navigate to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		const textarea1 = await waitForElement(page, 'textarea');

		// Send a message (DON'T wait for completion)
		await textarea1.fill('Write a long detailed explanation of quantum computing');
		await page.click('button[type="submit"]');

		// Wait for message to start processing (sending state)
		await page.waitForTimeout(1000);

		// Switch to session 2 WHILE session 1 is still processing
		await page.click(`[data-session-id="${sessionIds[1]}"]`);
		await waitForElement(page, 'textarea');

		// Send a message in session 2
		const textarea2 = page.locator('textarea').first();
		await textarea2.fill('Hello from session 2');
		await page.click('button[type="submit"]');

		// Wait for processing
		await page.waitForTimeout(2000);

		// VERIFY: Session 2's message appears
		await expect(page.locator('text="Hello from session 2"')).toBeVisible();

		// Switch back to session 1
		await page.click(`[data-session-id="${sessionIds[0]}"]`);
		await page.waitForTimeout(1000);

		// VERIFY: Session 1's message should be there (even if still processing)
		await expect(page.locator('text="quantum computing"')).toBeVisible();

		// VERIFY: Session 2's message should NOT be visible in session 1
		await expect(page.locator('text="Hello from session 2"')).not.toBeVisible();

		// Cleanup
		for (const sessionId of sessionIds) {
			await cleanupTestSession(page, sessionId);
		}
	});

	test('should maintain correct session context after multiple rapid switches', async ({
		page,
	}) => {
		await setupMessageHubTesting(page);

		// Create 3 sessions with unique messages
		const sessionData: Array<{ id: string; message: string }> = [];

		for (let i = 0; i < 3; i++) {
			await page.click('button:has-text("New Session")');
			const sessionId = await waitForSessionCreated(page);

			// Send unique message
			const message = `Unique message ${i + 1} - ${Math.random().toString(36).substring(7)}`;
			const textarea = await waitForElement(page, 'textarea');
			await textarea.fill(message);
			await page.click('button[type="submit"]');

			// Wait for message to appear
			await expect(page.locator(`text="${message}"`)).toBeVisible({ timeout: 5000 });

			sessionData.push({ id: sessionId, message });

			// Go home
			if (i < 2) {
				await page.click('h1:has-text("Liuboer")');
				await page.waitForTimeout(300);
			}
		}

		// Perform RAPID SWITCHING (10 iterations through all sessions)
		for (let iteration = 0; iteration < 10; iteration++) {
			for (const session of sessionData) {
				await page.click(`[data-session-id="${session.id}"]`);
				await page.waitForTimeout(100);
			}
		}

		// VERIFY: Each session still shows its correct unique message
		for (const session of sessionData) {
			await page.click(`[data-session-id="${session.id}"]`);
			await waitForElement(page, 'textarea');

			// Should show its own message
			await expect(page.locator(`text="${session.message}"`)).toBeVisible({ timeout: 5000 });

			// Should NOT show other sessions' messages
			for (const otherSession of sessionData) {
				if (otherSession.id !== session.id) {
					await expect(page.locator(`text="${otherSession.message}"`)).not.toBeVisible();
				}
			}
		}

		// Cleanup
		for (const session of sessionData) {
			await cleanupTestSession(page, session.id);
		}
	});
});
