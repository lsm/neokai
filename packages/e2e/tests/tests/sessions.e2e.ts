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
    // Get initial session count
    const initialCount = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });

    // Click "New Session" button
    const newSessionBtn = app.getByRole('button', { name: /New Session/i });
    await newSessionBtn.click();

    // Wait for navigation to happen (currentSessionId should be set)
    await app.waitForFunction(
      () => {
        // @ts-ignore
        return window.currentSessionIdSignal?.value !== null;
      },
      { timeout: 5000 }
    );

    // Wait for state channels to sync the new session (may take a bit longer in multi-worker tests)
    await app.waitForFunction(
      (expectedCount) => {
        // @ts-ignore
        return (window.sessions?.value?.length || 0) >= expectedCount;
      },
      initialCount + 1,
      { timeout: 10000 }
    );

    // Verify session count increased
    const newCount = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });

    expect(newCount).toBeGreaterThanOrEqual(initialCount + 1);

    // Verify we're in session view
    const inSessionView = await app.evaluate(() => {
      // @ts-ignore
      return window.currentSessionIdSignal?.value !== null;
    });

    expect(inSessionView).toBe(true);
  });

  test('should display session list correctly', async ({ app }) => {
    // Get sessions from state
    const sessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    if (sessions.length > 0) {
      // Verify session cards are displayed
      const sessionCards = app.getByTestId('session-card');
      const count = await sessionCards.count();
      expect(count).toBe(sessions.length);
    }
  });

  test('should delete a session and update UI automatically', async ({ app }) => {
    // Get initial sessions
    const initialSessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    // Skip if no sessions
    if (initialSessions.length === 0) {
      test.skip();
      return;
    }

    const initialCount = initialSessions.length;
    const sessionToDelete = initialSessions[0];

    // Navigate to session view by clicking first session card
    const firstSession = app.getByTestId('session-card').first();
    await firstSession.click();

    // Wait for chat view to load (message input should be visible)
    await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Click session options button (three dots) in chat header
    const optionsBtn = app.getByRole('button', { name: /Session options/i });
    await optionsBtn.click();

    // Wait for dropdown to appear and click "Delete Chat"
    await app.waitForTimeout(200);
    const deleteBtn = app.getByText('Delete Chat');
    await deleteBtn.click();

    // Wait for modal to appear and confirm deletion
    const confirmBtn = app.getByTestId('confirm-delete-session');
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();

    // Wait for deletion to complete - session should disappear from list
    await app.waitForFunction(
      (deletedId) => {
        // @ts-ignore
        const sessions = window.sessions?.value || [];
        return !sessions.some((s: any) => s.id === deletedId);
      },
      sessionToDelete.id,
      { timeout: 10000 }
    );

    // Verify we're redirected back to home (currentSessionId should be null or undefined)
    const currentSessionId = await app.evaluate(() => {
      // @ts-ignore
      return window.currentSessionIdSignal?.value;
    });
    expect(currentSessionId == null).toBe(true); // Checks for both null and undefined

    // Verify session count decreased via state channels
    const newCount = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });
    expect(newCount).toBe(initialCount - 1);

    // Verify the deleted session is not in the list
    const remainingSessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    const hasDeletedSession = remainingSessions.some((s: any) => s.id === sessionToDelete.id);
    expect(hasDeletedSession).toBe(false);

    // Verify UI updated - session cards count matches
    const sessionCards = app.getByTestId('session-card');
    const visibleCount = await sessionCards.count();
    expect(visibleCount).toBe(newCount);
  });

  test('should navigate to session and load messages', async ({ app }) => {
    const sessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    // Skip if no sessions
    if (sessions.length === 0) {
      test.skip();
      return;
    }

    // Click first session
    const firstSession = app.getByTestId('session-card').first();
    await firstSession.click();

    // Wait for chat container to load
    await app.waitForTimeout(1000);

    // Verify message input is visible (indicates chat loaded)
    await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Verify currentSession state is set
    const currentSession = await app.evaluate(() => {
      // @ts-ignore
      return window.currentSession?.value;
    });

    expect(currentSession).toBeTruthy();
    expect(currentSession.id).toBe(sessions[0].id);
  });

  test('should show session metadata correctly', async ({ app }) => {
    const sessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    if (sessions.length > 0) {
      // Each session should show message count and time
      const sessionCards = app.getByTestId('session-card');
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
