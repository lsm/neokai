/**
 * State Synchronization E2E Tests
 *
 * Tests the reactive state management system:
 * - State channels initialize correctly
 * - Sessions list loads from state channels
 * - Auth status displays correctly
 * - MessageHub connection is stable
 */

import { test, expect } from '../fixtures/app.fixture';

test.describe('State Synchronization', () => {
  test('should initialize state channels and load sessions', async ({ app }) => {
    // Verify MessageHub is connected
    const isConnected = await app.evaluate(() => {
      // @ts-ignore
      return window.connectionManager?.isConnected();
    });
    expect(isConnected).toBe(true);

    // Verify state channels initialized
    const stateInitialized = await app.evaluate(() => {
      // @ts-ignore
      return window.appState?.global?.value !== null;
    });
    expect(stateInitialized).toBe(true);

    // Verify sessions loaded
    const sessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });
    expect(Array.isArray(sessions)).toBe(true);

    // Verify sessions are displayed in UI
    const sessionElements = app.getByTestId('session-card');
    const count = await sessionElements.count();
    expect(count).toBe(sessions.length);
  });

  test('should display auth status correctly', async ({ app }) => {
    // Get auth status from state
    const authStatus = await app.evaluate(() => {
      // @ts-ignore
      return window.authStatus?.value;
    });

    // If authenticated, should show auth method
    if (authStatus?.isAuthenticated) {
      expect(authStatus.method).toBeTruthy();

      // Verify UI shows authentication
      await expect(app.getByText(/OAuth Token|API Key/i)).toBeVisible();
    } else {
      // Verify UI shows not configured
      await expect(app.getByText(/Not configured/i)).toBeVisible();
    }
  });

  test('should show connected status', async ({ app }) => {
    // Verify status indicator shows connected
    await expect(app.getByText('Connected')).toBeVisible();
  });

  test('should have no MessageHub connection errors in console', async ({ app }) => {
    const consoleErrors: string[] = [];

    app.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Reload the page to test HMR-like scenario
    await app.reload();

    // Wait for state to initialize again
    await app.waitForFunction(() => {
      // @ts-ignore
      return window.appState?.global?.value !== null;
    });

    // Check that no "MessageHub not connected" errors occurred
    const hasConnectionError = consoleErrors.some(err =>
      err.includes('MessageHub not connected')
    );
    expect(hasConnectionError).toBe(false);
  });

  test('should maintain state across navigation', async ({ app }) => {
    // Get initial sessions
    const initialSessions = await app.evaluate(() => {
      // @ts-ignore
      return window.sessions?.value || [];
    });

    // If there are sessions, click one
    if (initialSessions.length > 0) {
      const firstSession = app.getByTestId('session-card').first();
      await firstSession.click();

      // Wait a bit for navigation
      await app.waitForTimeout(500);

      // Navigate back home
      const homeButton = app.getByRole('heading', { name: 'Liuboer' });
      await homeButton.click();

      // Wait for navigation
      await app.waitForTimeout(500);

      // Verify sessions still available
      const sessionsAfterNav = await app.evaluate(() => {
        // @ts-ignore
        return window.sessions?.value || [];
      });

      expect(sessionsAfterNav.length).toBe(initialSessions.length);
    }
  });
});
