/**
 * Multi-Tab Synchronization E2E Tests
 *
 * Tests that state channels sync across browser tabs:
 * - Create session in Tab A → appears in Tab B
 * - Delete session in Tab B → removed from Tab A
 * - State channels use pub/sub for cross-tab sync
 */

import { test, expect } from '@playwright/test';

test.describe('Multi-Tab Synchronization', () => {
  test('should sync session creation across tabs', async ({ browser }) => {
    // Create two browser contexts (tabs)
    const context = await browser.newContext();
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    // Navigate both tabs to the app
    await tabA.goto('http://localhost:9283');
    await tabB.goto('http://localhost:9283');

    // Wait for state initialization in both tabs
    await Promise.all([
      tabA.waitForFunction(() => {
        // @ts-ignore
        return window.appState?.global?.value !== null;
      }),
      tabB.waitForFunction(() => {
        // @ts-ignore
        return window.appState?.global?.value !== null;
      }),
    ]);

    // Get initial session count in Tab B
    const initialCount = await tabB.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });

    // Create session in Tab A
    const newSessionBtn = tabA.getByRole('button', { name: /New Session/i });
    await newSessionBtn.click();

    // Wait for navigation in Tab A
    await tabA.waitForFunction(
      () => {
        // @ts-ignore
        return window.currentSessionIdSignal?.value !== null;
      },
      { timeout: 5000 }
    );

    // Wait for state channels to sync the new session in Tab A (longer timeout for multi-worker)
    await tabA.waitForFunction(
      (expectedCount) => {
        // @ts-ignore
        return (window.sessions?.value?.length || 0) >= expectedCount;
      },
      initialCount + 1,
      { timeout: 10000 }
    );

    // Verify Tab A has the new session
    const tabACount = await tabA.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });
    expect(tabACount).toBeGreaterThanOrEqual(initialCount + 1);

    // Wait for pub/sub to sync to Tab B (give it up to 3 seconds)
    await tabB.waitForFunction(
      (expectedCount) => {
        // @ts-ignore
        return (window.sessions?.value?.length || 0) >= expectedCount;
      },
      initialCount + 1,
      { timeout: 3000 }
    );

    // Verify Tab B also has the new session
    const tabBCount = await tabB.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });
    expect(tabBCount).toBeGreaterThanOrEqual(initialCount + 1);

    await context.close();
  });

  test('should sync session deletion across tabs', async ({ browser }) => {
    // Create two browser contexts (tabs)
    const context = await browser.newContext();
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    // Navigate both tabs to the app
    await tabA.goto('http://localhost:9283');
    await tabB.goto('http://localhost:9283');

    // Wait for state initialization
    await Promise.all([
      tabA.waitForFunction(() => {
        // @ts-ignore
        return window.appState?.global?.value !== null;
      }),
      tabB.waitForFunction(() => {
        // @ts-ignore
        return window.appState?.global?.value !== null;
      }),
    ]);

    // Get sessions in both tabs
    const sessions = await tabA.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    // Skip if no sessions to delete
    if (sessions.length === 0) {
      await context.close();
      test.skip();
      return;
    }

    const initialCount = sessions.length;
    const sessionToDelete = sessions[0];

    // In Tab B, click first session to make options button visible
    const firstSession = tabB.getByTestId('session-card').first();
    await firstSession.click();

    // Wait for chat view to load (message input should be visible)
    await expect(tabB.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Delete the session in Tab B
    const optionsBtn = tabB.getByRole('button', { name: /Session options/i });
    await optionsBtn.click();
    await tabB.waitForTimeout(200);

    const deleteBtn = tabB.getByText('Delete Chat');
    await deleteBtn.click();

    // Wait for modal to appear and confirm deletion
    const confirmBtn = tabB.getByTestId('confirm-delete-session');
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();

    // Wait for deletion to complete - session should disappear from list in Tab B
    await tabB.waitForFunction(
      (deletedId) => {
        // @ts-ignore
        const sessions = window.sessions?.value || [];
        return !sessions.some((s: any) => s.id === deletedId);
      },
      sessionToDelete.id,
      { timeout: 10000 }
    );

    // Verify Tab B shows deletion
    const tabBCount = await tabB.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });
    expect(tabBCount).toBe(initialCount - 1);

    // Wait for pub/sub to sync to Tab A (MessageHub should sync via WebSocket)
    await tabA.waitForFunction(
      (expectedCount) => {
        // @ts-ignore
        return (window.sessions?.value?.length || 0) === expectedCount;
      },
      initialCount - 1,
      { timeout: 3000 }
    );

    // Verify Tab A also shows deletion
    const tabACount = await tabA.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value?.length || 0;
    });
    expect(tabACount).toBe(initialCount - 1);

    // Verify deleted session is not in Tab A's list
    const tabASessions = await tabA.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });
    const hasDeletedSession = tabASessions.some((s: any) => s.id === sessionToDelete.id);
    expect(hasDeletedSession).toBe(false);

    // Verify UI in Tab A updated correctly
    const tabASessionCards = tabA.getByTestId('session-card');
    const tabAVisibleCount = await tabASessionCards.count();
    expect(tabAVisibleCount).toBe(tabACount);

    await context.close();
  });
});
