import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * E2E tests for Question Form Persistence
 *
 * Tests that the question form (AskUserQuestion) remains visible after submission
 * and displays correctly in both active and read-only states.
 */

test.describe('Question Form Persistence', () => {
	let page: Page;

	/**
	 * Helper: Create a new session
	 */
	async function createSession(page: Page): Promise<void> {
		await page.goto('/');
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});
		await page.click('button:has-text("New Session")');
		await page.waitForSelector('[data-testid="message-input"], textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});
	}

	/**
	 * Helper: Send a message that will trigger AskUserQuestion
	 */
	async function sendQuestionTriggeringMessage(page: Page): Promise<void> {
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill(
			'Please ask me a question about whether I want to create a new file or edit an existing one. Wait for my response before proceeding.'
		);

		const sendButton = page.locator('button[aria-label*="Send"], button:has-text("Send")').first();
		await sendButton.click();
	}

	/**
	 * Helper: Wait for question form to appear and return it
	 */
	async function waitForQuestionForm(page: Page): Promise<Locator> {
		await page.waitForSelector('[data-testid="question-prompt"]', {
			timeout: 30000,
		});
		return page.locator('[data-testid="question-prompt"]').first();
	}

	/**
	 * Helper: Select the first available option in the question form
	 */
	async function selectFirstOption(form: Locator): Promise<void> {
		// Options are in a grid layout; select the first non-"Other" option button
		const options = form.locator('.grid button');
		const count = await options.count();
		expect(count).toBeGreaterThan(0);
		await options.first().click();
	}

	/**
	 * Helper: Wait for Submit Response button to be enabled and return it
	 */
	async function getEnabledSubmitButton(form: Locator): Promise<Locator> {
		const submitButton = form.locator('button:has-text("Submit Response")');
		await expect(submitButton).toBeEnabled({ timeout: 5000 });
		return submitButton;
	}

	test.beforeEach(async ({ page: testPage }) => {
		page = testPage;
		await createSession(page);
	});

	test('question form should appear when agent asks a question', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Verify question form is visible and expanded
		await expect(form).toBeVisible();

		// Should have submit and skip buttons
		await expect(form.locator('button:has-text("Submit Response")')).toBeVisible();
		await expect(form.locator('button:has-text("Skip Question")')).toBeVisible();

		// Should have at least one option button in the grid
		const options = form.locator('.grid button');
		await expect(options.first()).toBeVisible();
	});

	test('question form should remain visible after submission', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Select an option
		await selectFirstOption(form);

		// Submit the response
		const submitButton = await getEnabledSubmitButton(form);
		await submitButton.click();

		// Wait for resolved state
		await expect(page.locator('[data-testid="question-prompt"]').first()).toBeVisible();

		// Should show "Response submitted" indicator
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});
	});

	test('question form should remain visible after skipping', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Skip the question
		const skipButton = form.locator('button:has-text("Skip Question")');
		await expect(skipButton).toBeVisible();
		await skipButton.click();

		// Form should still exist (now in resolved state)
		await expect(page.locator('[data-testid="question-prompt"]').first()).toBeVisible();

		// Form should show "Question skipped" state
		await expect(page.locator('text=Question skipped')).toBeVisible({
			timeout: 10000,
		});
	});

	test('question form should show selected options after submission', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Find and click an option, capture its text
		const firstOption = form.locator('.grid button').first();
		const selectedOptionText = await firstOption.textContent();
		await firstOption.click();

		// Submit
		const submitButton = await getEnabledSubmitButton(form);
		await submitButton.click();

		// Wait for resolved state
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});

		// The selected option should still be visible in the read-only form
		if (selectedOptionText) {
			const formAfter = page.locator('[data-testid="question-prompt"]').first();
			await expect(formAfter).toContainText(selectedOptionText);
		}
	});

	test('question form should handle skip and persist', async () => {
		// This test verifies that after skipping, the form stays in the DOM
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Count question prompts before skip
		const countBefore = await page.locator('[data-testid="question-prompt"]').count();
		expect(countBefore).toBeGreaterThanOrEqual(1);

		// Skip the question
		const skipButton = form.locator('button:has-text("Skip Question")');
		await skipButton.click();

		// Wait for state transition
		await expect(page.locator('text=Question skipped')).toBeVisible({
			timeout: 10000,
		});

		// Question prompt should still be in the DOM
		const countAfter = await page.locator('[data-testid="question-prompt"]').count();
		expect(countAfter).toBeGreaterThanOrEqual(countBefore);
	});

	test('question form should persist across page refresh', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Select and submit
		await selectFirstOption(form);
		const submitButton = await getEnabledSubmitButton(form);
		await submitButton.click();

		// Wait for resolved state
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});

		// Refresh the page
		await page.reload();

		// Wait for session to reload
		await page.waitForSelector('[data-testid="message-input"], textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});

		// The resolved question form should still be visible
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});
	});

	test('old question forms from previous sessions should be visible', async () => {
		// Navigate to home
		await page.goto('/');

		// Wait for app to load
		await page.waitForSelector('button:has-text("New Session")', {
			timeout: 10000,
		});

		// If there are existing sessions with question prompts, they should be visible
		const questionForms = page.locator('[data-testid="question-prompt"]');
		const count = await questionForms.count();
		if (count > 0) {
			for (let i = 0; i < count; i++) {
				await expect(questionForms.nth(i)).toBeVisible();
			}
		}
	});

	test('question form state should be preserved in session history', async () => {
		await sendQuestionTriggeringMessage(page);
		const form = await waitForQuestionForm(page);

		// Select option and submit
		await selectFirstOption(form);
		const submitButton = await getEnabledSubmitButton(form);
		await submitButton.click();

		// Wait for resolved state
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});

		// Send another message to continue conversation
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Continue with the task');
		const sendButton = page.locator('button[aria-label*="Send"], button:has-text("Send")').first();
		await sendButton.click();

		// Wait for response
		await page.waitForTimeout(5000);

		// Scroll up to see previous questions
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]');
			if (container) {
				container.scrollTop = 0;
			}
		});

		// The old question form should still be visible in history
		await expect(page.locator('text=Response submitted')).toBeVisible({
			timeout: 10000,
		});
	});
});
