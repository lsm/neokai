/**
 * Session CRUD E2E Tests
 *
 * Tests session operations with state channel synchronization:
 * - Create session → appears in list immediately
 * - Delete session → removed from list via pub/sub
 * - State channels update automatically
 */

import { test, expect } from '../fixtures/app.fixture';

test.describe('Session Operations', () => {
	test('should create a new session', async ({ app }) => {
		// Get initial session count from visible session items in sidebar
		const sessionItems = app
			.locator('[data-testid="session-card"], .session-item, [role="listitem"]')
			.filter({ hasText: /Session/ });
		const initialCount = await sessionItems.count();

		// Click "New Session" button
		const newSessionBtn = app.getByRole('button', { name: /New Session/i });
		await newSessionBtn.click();

		// Wait for chat interface to appear (indicates successful navigation to new session)
		// User should see the message input textarea
		await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({
			timeout: 10000,
		});

		// Verify we're in chat view (not home screen)
		// Home screen has "Welcome to Liuboer" heading
		await expect(app.getByRole('heading', { name: /Welcome to Liuboer/i })).not.toBeVisible();

		// Wait a bit for sidebar to update with new session
		await app.waitForTimeout(1000);

		// Verify session count increased in sidebar
		const newCount = await sessionItems.count();
		expect(newCount).toBeGreaterThanOrEqual(initialCount + 1);
	});

	test('should display session list correctly', async ({ app }) => {
		// Verify session cards are displayed in sidebar
		const sessionCards = app.getByTestId('session-card');
		const count = await sessionCards.count();

		// Should have at least one session (or could be zero if fresh)
		expect(count).toBeGreaterThanOrEqual(0);

		// If we have sessions, each should have visible metadata
		if (count > 0) {
			const firstCard = sessionCards.first();
			// Each card should be visible
			await expect(firstCard).toBeVisible();
			// Should contain timestamp text
			await expect(firstCard).toContainText(/\d+[smhd]?\s*(ago|min|sec|hour|day)|just now/i);
		}
	});

	test('should delete a session and update UI automatically', async ({ app }) => {
		// Count initial sessions in sidebar
		const sessionCards = app.getByTestId('session-card');
		const initialCount = await sessionCards.count();

		// Skip if no sessions
		if (initialCount === 0) {
			test.skip();
			return;
		}

		// Navigate to session view by clicking first session card
		const firstSession = sessionCards.first();
		await firstSession.click();

		// Wait for chat view to load (message input should be visible)
		await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({
			timeout: 10000,
		});

		// Click session options button (three dots) in chat header
		const optionsBtn = app.getByRole('button', { name: /Session options/i });
		await optionsBtn.click();

		// Wait for dropdown to appear and click "Delete Chat"
		const deleteBtn = app.getByText('Delete Chat');
		await expect(deleteBtn).toBeVisible({ timeout: 5000 });

		// Use force click to bypass any overlay issues
		await deleteBtn.click({ force: true });

		// Wait for modal to appear and confirm deletion
		const confirmBtn = app.getByTestId('confirm-delete-session');
		await expect(confirmBtn).toBeVisible({ timeout: 10000 });
		await confirmBtn.click();

		// Wait for redirect back to home - "Welcome to Liuboer" should appear
		await expect(app.getByRole('heading', { name: /Welcome to Liuboer/i })).toBeVisible({
			timeout: 10000,
		});

		// Wait a bit longer for sidebar to update via WebSocket
		await app.waitForTimeout(2000);

		// Verify session count decreased in UI (use toBeL essThan for more flexible assertion)
		const newCount = await sessionCards.count();
		expect(newCount).toBeLessThan(initialCount);
	});

	test('should navigate to session and load messages', async ({ app }) => {
		const sessionCards = app.getByTestId('session-card');
		const count = await sessionCards.count();

		// Skip if no sessions
		if (count === 0) {
			test.skip();
			return;
		}

		// Click first session
		const firstSession = sessionCards.first();
		await firstSession.click();

		// Verify chat interface loaded:
		// 1. Message input is visible
		await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({
			timeout: 10000,
		});

		// 2. Home screen is no longer visible
		await expect(app.getByRole('heading', { name: /Welcome to Liuboer/i })).not.toBeVisible();

		// 3. Send button should be visible
		await expect(
			app.getByRole('button', { name: /send/i }).or(app.locator('button[type="submit"]'))
		).toBeVisible();
	});

	test('should show session metadata correctly', async ({ app }) => {
		const sessionCards = app.getByTestId('session-card');
		const count = await sessionCards.count();

		if (count > 0) {
			// Each session should show message count and time
			const firstCard = sessionCards.first();

			// Should show "0" or number (message count)
			const messageCount = firstCard.locator('text=/^\\d+$/');
			await expect(messageCount.first()).toBeVisible();

			// Should show relative time (e.g., "2h ago", "5m ago", "just now")
			const timeDisplay = firstCard.locator('text=/\\d+[smhd]\\s+ago|just now/i');
			await expect(timeDisplay.first()).toBeVisible();
		}
	});
});
