/**
 * App Fixture
 *
 * Provides a page that's already navigated to the app
 * and waited for state initialization to complete.
 */

import { test as base, expect, type Page } from '@playwright/test';

/**
 * Wait for MessageHub to connect
 */
async function waitForMessageHubConnection(page: Page) {
  await page.waitForFunction(
    () => {
      // @ts-ignore - accessing global window object
      return window.connectionManager?.isConnected() === true;
    },
    { timeout: 10000 }
  );
}

/**
 * Wait for state channels to initialize
 */
async function waitForStateInitialization(page: Page) {
  await page.waitForFunction(
    () => {
      // @ts-ignore - accessing global window object
      return window.appState?.global?.value !== null;
    },
    { timeout: 10000 }
  );
}

/**
 * Wait for sessions to load
 */
async function waitForSessionsLoaded(page: Page) {
  await page.waitForFunction(
    () => {
      // @ts-ignore - accessing global window object
      const sessions = window.sessions?.value;
      return Array.isArray(sessions);
    },
    { timeout: 10000 }
  );
}

/**
 * Extended test with app fixture
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for MessageHub connection
    await waitForMessageHubConnection(page);

    // Wait for state initialization
    await waitForStateInitialization(page);

    // Wait for sessions to load
    await waitForSessionsLoaded(page);

    // Expose the page as 'app'
    await use(page);
  },
});

export { expect };
