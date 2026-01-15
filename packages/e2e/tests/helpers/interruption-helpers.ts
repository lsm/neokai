/**
 * Interruption and Error Handling Test Helpers
 *
 * Shared utility functions for interruption and error handling E2E tests.
 * Extracted from interruption-error.e2e.ts for reusability.
 */

import type { Page } from '../fixtures';

/**
 * Simulate network failure by going offline
 */
export async function simulateNetworkFailure(page: Page): Promise<void> {
	await page.context().setOffline(true);
}

/**
 * Restore network by going back online
 */
export async function restoreNetwork(page: Page): Promise<void> {
	await page.context().setOffline(false);
}
