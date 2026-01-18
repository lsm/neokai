/**
 * File Attachment Preview E2E Tests
 *
 * Tests for image preview and removal functionality:
 * - Image preview before sending
 * - Removing attached images
 */

import { test, expect } from '../fixtures';
import { cleanupTestSession, waitForSessionCreated } from './helpers/wait-helpers';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create test image fixtures
const fixturesDir = path.join(__dirname, 'fixtures', 'images');
const testImagePath = path.join(fixturesDir, 'test-image.png');

test.describe('File Attachment - Preview', () => {
	let sessionId: string | null = null;

	test.beforeAll(() => {
		// Create fixtures directory
		if (!fs.existsSync(fixturesDir)) {
			fs.mkdirSync(fixturesDir, { recursive: true });
		}

		// Create a simple 1x1 PNG test image (valid PNG)
		const pngData = Buffer.from([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a, // PNG signature
			0x00,
			0x00,
			0x00,
			0x0d,
			0x49,
			0x48,
			0x44,
			0x52, // IHDR chunk
			0x00,
			0x00,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x01, // 1x1 pixels
			0x08,
			0x06,
			0x00,
			0x00,
			0x00,
			0x1f,
			0x15,
			0xc4,
			0x89, // etc.
			0x00,
			0x00,
			0x00,
			0x0a,
			0x49,
			0x44,
			0x41,
			0x54, // IDAT chunk
			0x78,
			0x9c,
			0x63,
			0x00,
			0x01,
			0x00,
			0x00,
			0x05,
			0x00,
			0x01,
			0x00,
			0x00,
			0x00,
			0x0d,
			0x49,
			0x45,
			0x4e,
			0x44, // IEND chunk
			0xae,
			0x42,
			0x60,
			0x82,
		]);

		fs.writeFileSync(testImagePath, pngData);
	});

	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'Liuboer', exact: true }).first()).toBeVisible();
		await page.waitForTimeout(1000);
		sessionId = null;
	});

	test.afterEach(async ({ page }) => {
		if (sessionId) {
			try {
				await cleanupTestSession(page, sessionId);
			} catch (error) {
				console.warn(`Failed to cleanup session ${sessionId}:`, error);
			}
			sessionId = null;
		}
	});

	test('should preview attached image before sending', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Click the plus button
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();

		// Attach a test image
		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.locator('button:has-text("Attach image")').click();
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles(testImagePath);

		// Wait for the image to be processed
		await page.waitForTimeout(1000);

		// The attachment preview should show the remove button (aria-label)
		const removeButton = page.locator('button[aria-label="Remove attachment"]');
		await expect(removeButton).toBeVisible({ timeout: 10000 });

		// Should show image thumbnail (data: URL)
		const thumbnail = page.locator('img[src^="data:"]').first();
		await expect(thumbnail).toBeVisible();
	});

	test('should allow removing attached image', async ({ page }) => {
		// Create a new session
		await page.getByRole('button', { name: 'New Session', exact: true }).click();
		sessionId = await waitForSessionCreated(page);

		// Attach an image
		const plusButton = page.locator('button[title="More options"]');
		await plusButton.click();

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.locator('button:has-text("Attach image")').click();
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles(testImagePath);

		await page.waitForTimeout(1000);

		// Find the remove button (might need hover to show)
		const removeButton = page.locator('button[aria-label="Remove attachment"]').first();
		await expect(removeButton).toBeVisible({ timeout: 10000 });

		// Hover to ensure button is clickable
		await removeButton.hover();

		// Click remove button
		await removeButton.click();

		// Attachment preview (and its remove button) should disappear
		await expect(removeButton).not.toBeVisible({ timeout: 5000 });
	});
});
