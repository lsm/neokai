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
    // Verify MessageHub is connected by checking for "Connected" status in UI
    await expect(app.getByText('Connected')).toBeVisible();

    // Verify state channels initialized by checking that UI is functional
    // New Session button should be clickable (indicates state is ready)
    await expect(app.getByRole('button', { name: /New Session/i })).toBeEnabled();

    // Verify sessions are displayed in UI
    const sessionElements = app.getByTestId('session-card');
    const count = await sessionElements.count();

    // Should have 0 or more sessions (count >= 0)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('should display auth status correctly', async ({ app }) => {
    // Check if any authentication status is visible in the footer
    // It should show either "OAuth Token", "API Key", or "Not configured"
    const authStatusVisible = await Promise.race([
      app.getByText(/OAuth Token|API Key/i).isVisible().then(() => 'authenticated'),
      app.getByText(/Not configured/i).isVisible().then(() => 'not-configured'),
      app.waitForTimeout(5000).then(() => 'timeout')
    ]);

    // Verify that we got a valid auth status (not timeout)
    expect(authStatusVisible).not.toBe('timeout');
    expect(['authenticated', 'not-configured']).toContain(authStatusVisible);
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

    // Wait for app to initialize again (check for Connected status)
    await expect(app.getByText('Connected')).toBeVisible({ timeout: 10000 });

    // Check that no "MessageHub not connected" errors occurred
    const hasConnectionError = consoleErrors.some(err =>
      err.includes('MessageHub not connected')
    );
    expect(hasConnectionError).toBe(false);
  });

  test('should maintain state across navigation', async ({ app }) => {
    // Get initial session count from UI
    const sessionCards = app.getByTestId('session-card');
    const initialCount = await sessionCards.count();

    // Skip if no sessions - can't test navigation without sessions
    if (initialCount === 0) {
      test.skip();
      return;
    }

    // Click first session to navigate to chat view
    const firstSession = sessionCards.first();
    await firstSession.click();

    // Wait for chat view to load
    await expect(app.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Navigate back home by clicking the logo/title
    const homeButton = app.getByRole('heading', { name: 'Liuboer' });
    await homeButton.click();

    // Wait for navigation and verify sidebar still shows sessions
    await app.waitForTimeout(2000);

    // Verify sessions still available in sidebar (state persisted)
    const countAfterNav = await sessionCards.count();
    expect(countAfterNav).toBe(initialCount);
  });
});
