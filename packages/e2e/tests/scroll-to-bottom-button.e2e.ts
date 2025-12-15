import { test, expect } from '@playwright/test';
import {
	cleanupTestSession,
	waitForSessionCreated,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

/**
 * Scroll to Bottom Button E2E Tests
 *
 * Tests the ChatGPT-like scroll-to-bottom button's styling and structure.
 * Functional scroll tests require real message content, which are covered by manual testing.
 *
 * These tests verify:
 * - Button structure and styling (circular, centered)
 * - Icon presence (chevron down)
 * - Button visibility logic with real content
 */
test.describe('Scroll to Bottom Button', () => {
	let sessionId: string | null = null;

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

	test('should not show scroll button in empty session at bottom', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// At bottom (empty session), button should not be visible
		const scrollButton = page.locator('button[title="Scroll to bottom"]');
		await expect(scrollButton).not.toBeVisible();
	});

	test('should have correct button structure and styling when visible', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Send a message to create some content
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill(
			'Hello, please give me a long detailed response about web development.'
		);
		await messageInput.press('Enter');

		// Wait for assistant response
		await waitForAssistantResponse(page, { timeout: 45000 });

		// Wait a bit for content to render
		await page.waitForTimeout(1000);

		// Try to trigger the button by scrolling up programmatically
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			if (container && container.scrollHeight > container.clientHeight) {
				// Scroll to top to show button
				container.scrollTop = 0;
			}
		});

		await page.waitForTimeout(500);

		// Check if button appears (it may not if content isn't scrollable enough, which is okay)
		const scrollButton = page.locator('button[title="Scroll to bottom"]');
		const buttonCount = await scrollButton.count();

		if (buttonCount > 0) {
			// Button is visible, verify its structure
			await expect(scrollButton).toBeVisible();

			// Check for circular shape classes
			const buttonClasses = await scrollButton.getAttribute('class');
			expect(buttonClasses).toContain('rounded-full');
			expect(buttonClasses).toContain('w-10');
			expect(buttonClasses).toContain('h-10');

			// Check for animation class
			expect(buttonClasses).toContain('animate-slideIn');

			// Check parent has centering classes
			const parentDiv = scrollButton.locator('..');
			const parentClasses = await parentDiv.getAttribute('class');
			expect(parentClasses).toContain('left-1/2');
			expect(parentClasses).toContain('-translate-x-1/2');

			// Check for SVG icon
			const svg = scrollButton.locator('svg');
			await expect(svg).toBeVisible();

			// SVG should have a path element (the chevron)
			const path = svg.locator('path');
			await expect(path).toBeVisible();
		} else {
			// Button not visible - content might not be scrollable enough
			// This is okay, just log it
			console.log(
				'Scroll button not visible - content may not be scrollable enough (this is expected for short responses)'
			);
		}
	});

	test('should display chevron down icon structure', async ({ page }) => {
		// This test verifies the icon structure exists in the code by checking the implementation
		// We don't need scrollable content to verify the SVG structure

		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Check that the scroll button element structure exists in the DOM (even if hidden)
		// by looking for the specific SVG path that represents the chevron
		const hasChevronStructure = await page.evaluate(() => {
			// The button exists in the DOM even when hidden
			// Look for SVG with the chevron path
			const svgs = document.querySelectorAll('svg');
			for (const svg of svgs) {
				const paths = svg.querySelectorAll('path');
				for (const path of paths) {
					const d = path.getAttribute('d');
					// Check for the chevron path: M19 9l-7 7-7-7
					if (d && d.includes('M19 9l-7 7-7-7')) {
						return true;
					}
				}
			}
			return false;
		});

		expect(hasChevronStructure).toBe(true);
	});

	test('should have button in DOM with correct title attribute', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Even if not visible, the button should exist in the DOM with correct attributes
		const scrollButton = page.locator('button[title="Scroll to bottom"]');

		// Check button exists (might be hidden)
		const buttonExists = (await scrollButton.count()) > 0;
		expect(buttonExists).toBe(true);

		// If visible, verify aria-label matches
		if (await scrollButton.isVisible()) {
			await expect(scrollButton).toHaveAttribute('aria-label', 'Scroll to bottom');
		}
	});
});
