/**
 * Multi-Tab Synchronization E2E Tests
 *
 * Tests that state channels sync across browser tabs via WebSocket pub/sub:
 * - Create session in Tab A → appears in Tab B
 * - Delete session in Tab B → removed from Tab A
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

    // Wait for app to load in both tabs (sidebar + "New Session" button visible)
    await Promise.all([
      tabA.getByRole('button', { name: /New Session/i }).waitFor({ state: 'visible', timeout: 10000 }),
      tabB.getByRole('button', { name: /New Session/i }).waitFor({ state: 'visible', timeout: 10000 }),
    ]);

    // Count initial sessions in Tab B by counting session cards in sidebar
    const initialCountB = await tabB.getByTestId('session-card').count();

    // Create session in Tab A
    const newSessionBtn = tabA.getByRole('button', { name: /New Session/i });
    await newSessionBtn.click();

    // Wait for chat interface to appear in Tab A (indicates session created)
    await expect(tabA.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Wait a bit for WebSocket pub/sub to sync to Tab B
    await tabB.waitForTimeout(2000);

    // Verify Tab B sidebar shows the new session
    const newCountB = await tabB.getByTestId('session-card').count();
    expect(newCountB).toBeGreaterThanOrEqual(initialCountB + 1);

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

    // Wait for app to load
    await Promise.all([
      tabA.getByRole('button', { name: /New Session/i }).waitFor({ state: 'visible', timeout: 10000 }),
      tabB.getByRole('button', { name: /New Session/i }).waitFor({ state: 'visible', timeout: 10000 }),
    ]);

    // Count sessions in both tabs
    const initialCountA = await tabA.getByTestId('session-card').count();
    const initialCountB = await tabB.getByTestId('session-card').count();

    // Skip if no sessions to delete
    if (initialCountB === 0) {
      await context.close();
      test.skip();
      return;
    }

    // In Tab B, click first session to open it
    const firstSession = tabB.getByTestId('session-card').first();
    await firstSession.click();

    // Wait for chat view to load
    await expect(tabB.getByPlaceholder(/Ask, search, or make anything/i)).toBeVisible({ timeout: 10000 });

    // Delete the session in Tab B
    const optionsBtn = tabB.getByRole('button', { name: /Session options/i });
    await optionsBtn.click();
    await tabB.waitForTimeout(200);

    const deleteBtn = tabB.getByText('Delete Chat');
    await deleteBtn.click();

    // Confirm deletion
    const confirmBtn = tabB.getByTestId('confirm-delete-session');
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();

    // Wait for redirect to home in Tab B
    await expect(tabB.getByRole('heading', { name: /Welcome to Liuboer/i })).toBeVisible({ timeout: 10000 });

    // Wait for Tab B sidebar to update
    await tabB.waitForTimeout(1000);

    // Verify Tab B shows one fewer session
    const newCountB = await tabB.getByTestId('session-card').count();
    expect(newCountB).toBe(initialCountB - 1);

    // Wait for WebSocket pub/sub to sync to Tab A
    await tabA.waitForTimeout(2000);

    // Verify Tab A also shows one fewer session
    const newCountA = await tabA.getByTestId('session-card').count();
    expect(newCountA).toBe(initialCountA - 1);

    await context.close();
  });
});
