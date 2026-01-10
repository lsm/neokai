import { test, expect } from '../fixtures';
import {
	cleanupTestSession,
	waitForSessionCreated,
	waitForAssistantResponse,
} from './helpers/wait-helpers';

/**
 * Scroll to Bottom Button E2E Tests
 *
 * Tests the ChatGPT-like scroll-to-bottom button functionality.
 * These tests verify the actual bug that was fixed:
 * 1. Button appears when scrolled away from bottom
 * 2. Button hides when at bottom
 * 3. Button works when clicked (scrolls to bottom)
 * 4. Parent container has correct positioning
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

	test('should not show button when at bottom of empty session', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// At bottom (empty session), button should not be visible to the user
		const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
		await expect(scrollButton).not.toBeVisible();
	});

	test('should show button when scrolled away from bottom with real content', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages to create scrollable content
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();

		// Send first message
		await messageInput.fill('Please explain React hooks in detail with examples.');
		await messageInput.press('Enter');
		await waitForAssistantResponse(page, { timeout: 45000 });

		// Send second message to ensure we have enough content
		await messageInput.fill('Now explain useEffect hook with 5 detailed examples.');
		await messageInput.press('Enter');
		await waitForAssistantResponse(page, { timeout: 45000 });

		// Wait for content to fully render
		await page.waitForTimeout(1000);

		// Verify we have scrollable content
		const hasScrollableContent = await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			return container && container.scrollHeight > container.clientHeight;
		});

		// Skip test if content isn't scrollable (this can happen with short responses)
		if (!hasScrollableContent) {
			test.skip();
			return;
		}

		// Scroll to top to trigger button appearance
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			if (container) {
				container.scrollTop = 0;
			}
		});

		// Wait for React to update state
		await page.waitForTimeout(500);

		// Button MUST be visible to the user now
		const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
		await expect(scrollButton).toBeVisible({ timeout: 5000 });

		// Verify button has correct visual styling (user can see these)
		const buttonClasses = await scrollButton.getAttribute('class');
		expect(buttonClasses).toContain('rounded-full');
		expect(buttonClasses).toContain('w-10');
		expect(buttonClasses).toContain('h-10');

		// Verify button is positioned correctly (bottom center of viewport)
		const buttonBox = await scrollButton.boundingBox();
		expect(buttonBox).not.toBeNull();

		// Button should be in the lower portion of the viewport
		const viewportHeight = page.viewportSize()?.height || 0;
		expect(buttonBox!.y).toBeGreaterThan(viewportHeight * 0.5);

		// Verify icon is visible to user
		const svg = scrollButton.locator('svg');
		await expect(svg).toBeVisible();
	});

	test('should scroll to bottom when button is clicked', async ({ page }) => {
		// Create a new session
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Send multiple messages to create scrollable content
		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Please write a long detailed explanation about TypeScript.');
		await messageInput.press('Enter');
		await waitForAssistantResponse(page, { timeout: 45000 });

		await messageInput.fill('Now explain async/await in JavaScript with examples.');
		await messageInput.press('Enter');
		await waitForAssistantResponse(page, { timeout: 45000 });

		await page.waitForTimeout(1000);

		// Verify scrollable content exists
		const hasScrollableContent = await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			return container && container.scrollHeight > container.clientHeight;
		});

		// Skip test if content isn't scrollable
		if (!hasScrollableContent) {
			test.skip();
			return;
		}

		// Scroll to top
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			if (container) container.scrollTop = 0;
		});
		await page.waitForTimeout(500);

		// Button should be visible to user
		const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
		await expect(scrollButton).toBeVisible({ timeout: 5000 });

		// User clicks the button
		await scrollButton.click();

		// Wait for smooth scroll animation to complete
		await page.waitForTimeout(1000);

		// Verify user can see the last message (button scrolled us to bottom)
		const lastMessage = page.locator('[data-messages-container] > div > *').last();
		await expect(lastMessage).toBeInViewport();

		// Button should now be hidden from user's view
		await expect(scrollButton).not.toBeVisible();
	});

	test('should hide button when user scrolls to bottom', async ({ page }) => {
		// Create session and content
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
		await messageInput.fill('Explain Promise chains with detailed examples.');
		await messageInput.press('Enter');
		await waitForAssistantResponse(page, { timeout: 45000 });

		await page.waitForTimeout(1000);

		// Check if we have scrollable content
		const hasScrollableContent = await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			return container && container.scrollHeight > container.clientHeight;
		});

		if (!hasScrollableContent) {
			test.skip();
			return;
		}

		// Scroll to top - button should appear
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]') as HTMLElement;
			if (container) container.scrollTop = 0;
		});
		await page.waitForTimeout(500);

		// User should see the button
		const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
		await expect(scrollButton).toBeVisible({ timeout: 5000 });

		// User scrolls down manually (using mouse wheel simulation)
		const messagesContainer = page.locator('[data-messages-container]');
		await messagesContainer.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(500);

		// Button should disappear from user's view
		await expect(scrollButton).not.toBeVisible();
	});

	test('should verify parent container has position relative', async ({ page }) => {
		// This tests the bug fix: parent must have position:relative for absolute button
		await page.locator('button:has-text("New Session")').first().click();
		sessionId = await waitForSessionCreated(page);

		// Check the chat container has position: relative
		const hasRelativePosition = await page.evaluate(() => {
			const chatContainer = document.querySelector(
				'.flex-1.flex.flex-col.bg-dark-900.overflow-x-hidden.relative'
			) as HTMLElement;
			if (!chatContainer) return false;

			const computedStyle = window.getComputedStyle(chatContainer);
			return computedStyle.position === 'relative';
		});

		expect(hasRelativePosition).toBe(true);
	});
});
