import { test, expect } from '../fixtures';
import { cleanupTestSession } from './helpers/wait-helpers';

test.describe('Session List Ordering', () => {
	const sessionIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
	});

	test.afterEach(async ({ page }) => {
		// Cleanup all sessions created during the test
		for (const sessionId of sessionIds) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
		}
		sessionIds.length = 0; // Clear array
	});

	test('should show newly created session at top of session list', async ({ page }) => {
		// Create first session
		const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
		await newSessionButton.click();
		await page.waitForTimeout(1500);

		// Get first session ID
		const firstSessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});
		if (firstSessionId) sessionIds.push(firstSessionId);

		// Go back to home
		await page.goto('/');
		await page.waitForTimeout(500);

		// Create second session
		await newSessionButton.click();
		await page.waitForTimeout(1500);

		// Get second session ID
		const secondSessionId = await page.evaluate(() => {
			const pathId = window.location.pathname.split('/').filter(Boolean)[0];
			return pathId && pathId !== 'undefined' ? pathId : null;
		});
		if (secondSessionId) sessionIds.push(secondSessionId);

		// Go back to home to see the session list
		await page.goto('/');
		await page.waitForTimeout(1000);

		// Get all session items from the sidebar
		const sessionItems = page.locator('[data-session-id]');
		const sessionCount = await sessionItems.count();

		// Should have at least our 2 sessions
		expect(sessionCount).toBeGreaterThanOrEqual(2);

		// Get the first two session IDs from the list
		const firstListItemId = await sessionItems.first().getAttribute('data-session-id');
		const secondListItemId = await sessionItems.nth(1).getAttribute('data-session-id');

		// The second session (most recently created) should be at the top
		expect(firstListItemId).toBe(secondSessionId);
		expect(secondListItemId).toBe(firstSessionId);
	});

	test('should maintain correct order after creating multiple sessions', async ({ page }) => {
		const createdSessionIds: string[] = [];

		// Create 3 sessions in sequence
		for (let i = 0; i < 3; i++) {
			const newSessionButton = page.getByRole('button', { name: 'New Session', exact: true });
			await newSessionButton.click();
			await page.waitForTimeout(1500);

			const sessionId = await page.evaluate(() => {
				const pathId = window.location.pathname.split('/').filter(Boolean)[0];
				return pathId && pathId !== 'undefined' ? pathId : null;
			});

			if (sessionId) {
				createdSessionIds.push(sessionId);
				sessionIds.push(sessionId);
			}

			// Go back to home for next iteration
			await page.goto('/');
			await page.waitForTimeout(500);
		}

		// Get all session items from the sidebar
		const sessionItems = page.locator('[data-session-id]');
		const sessionCount = await sessionItems.count();

		// Should have at least our 3 sessions
		expect(sessionCount).toBeGreaterThanOrEqual(3);

		// Get the first three session IDs from the list (newest first)
		const listSessionIds = [];
		for (let i = 0; i < 3; i++) {
			const sessionId = await sessionItems.nth(i).getAttribute('data-session-id');
			if (sessionId) listSessionIds.push(sessionId);
		}

		// Reverse createdSessionIds because newest should be first
		const expectedOrder = [...createdSessionIds].reverse();

		// Verify the order matches (newest first)
		expect(listSessionIds).toEqual(expectedOrder);
	});
});
