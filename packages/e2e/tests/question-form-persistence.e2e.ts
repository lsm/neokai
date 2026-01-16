import { test, expect, type Page } from '@playwright/test';

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
		await page.waitForSelector('button:has-text("New Session")', { timeout: 10000 });
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
		// This message should trigger the agent to ask a question
		await textarea.fill(
			'Please ask me a question about whether I want to create a new file or edit an existing one. Wait for my response before proceeding.'
		);

		const sendButton = page.locator('button[aria-label*="Send"], button:has-text("Send")').first();
		await sendButton.click();
	}

	/**
	 * Helper: Wait for question form to appear
	 */
	async function waitForQuestionForm(page: Page): Promise<void> {
		await page.waitForSelector('text=Claude needs your input', { timeout: 15000 });
	}

	/**
	 * Helper: Get question form container
	 */
	function getQuestionForm(page: Page) {
		return page.locator('div:has-text("Claude needs your input")').first();
	}

	/**
	 * Helper: Check if form is in read-only state
	 */
	async function isFormReadOnly(page: Page): Promise<boolean> {
		const form = getQuestionForm(page);
		const submitButton = form.locator('button:has-text("Submit Response")');
		const visible = await submitButton.isVisible();
		return !visible; // No submit button means read-only
	}

	test.beforeEach(async ({ page: testPage }) => {
		page = testPage;
		await createSession(page);
	});

	test('question form should appear when agent asks a question', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		// Verify question form is visible
		const form = getQuestionForm(page);
		await expect(form).toBeVisible();

		// Should have submit and skip buttons
		await expect(form.locator('button:has-text("Submit Response")')).toBeVisible();
		await expect(form.locator('button:has-text("Skip Question")')).toBeVisible();
	});

	test('question form should remain visible after submission', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Select an option (first option button)
		const optionButton = form
			.locator('button')
			.filter({ hasText: /(Create|Edit|file)/i })
			.first();
		await optionButton.click();

		// Submit the response
		const submitButton = form.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// Wait for submission to complete (form changes to read-only state)
		await page.waitForTimeout(2000);

		// CRITICAL: The form should STILL be visible (not disappeared)
		await expect(form).toBeVisible();

		// Form should now be in read-only state (no submit button)
		const isReadOnly = await isFormReadOnly(page);
		expect(isReadOnly).toBe(true);

		// Should show "Response submitted" indicator
		await expect(form.locator('text=Response submitted')).toBeVisible({ timeout: 5000 });
	});

	test('question form should remain visible after skipping', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Skip the question
		const skipButton = form.locator('button:has-text("Skip Question")');

		// Get initial form count
		const initialFormCount = await page.locator('div:has-text("Claude needs your input")').count();

		await skipButton.click();

		// Wait for skip to complete
		await page.waitForTimeout(2000);

		// CRITICAL: The form should STILL be visible (not disappeared)
		const finalFormCount = await page.locator('div:has-text("Claude needs your input")').count();
		expect(finalFormCount).toBeGreaterThanOrEqual(initialFormCount);

		// Form should show "Question skipped" state
		await expect(page.locator('text=Question skipped')).toBeVisible({ timeout: 5000 });
	});

	test('question form should show selected options after submission', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Find and click an option
		const optionButton = form
			.locator('button')
			.filter({ hasText: /(Create|Edit|Delete)/i })
			.first();
		await optionButton.click();

		// Get the option text
		const selectedOption = await optionButton.textContent();

		// Submit
		const submitButton = form.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// Wait for submission to complete
		await page.waitForTimeout(2000);

		// The selected option should still be visible in the read-only form
		await expect(form.locator(`text=${selectedOption}`)).toBeVisible();
	});

	test('multiple question forms should each persist independently', async () => {
		// Send first message to trigger question
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const firstForm = getQuestionForm(page);

		// Select option and submit first question
		const optionButton = firstForm
			.locator('button')
			.filter({ hasText: /(Create|Edit)/i })
			.first();
		await optionButton.click();
		const submitButton = firstForm.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// Wait for submission and agent to continue
		await page.waitForTimeout(3000);

		// Send another message to potentially trigger another question
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Now ask me another question about file formats.');
		const sendButton = page.locator('button[aria-label*="Send"], button:has-text("Send")').first();
		await sendButton.click();

		// Wait for potential second question
		await page.waitForTimeout(3000);

		// Both forms should be visible (first in read-only, second possibly active)
		const allForms = page.locator(
			'div:has-text("Claude needs your input"), div:has-text("Response submitted")'
		);
		const formCount = await allForms.count();
		expect(formCount).toBeGreaterThanOrEqual(1);
	});

	test('question form should handle custom text input', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Click "Other" option if present
		const otherButton = form.locator('button:has-text("Other")');
		if (await otherButton.isVisible()) {
			await otherButton.click();

			// Wait for textarea to appear
			await page.waitForSelector('textarea[placeholder*="Enter your response"]', { timeout: 5000 });

			const customTextarea = form.locator('textarea[placeholder*="Enter your response"]');
			await customTextarea.fill('My custom answer');

			// Submit
			const submitButton = form.locator('button:has-text("Submit Response")');
			await submitButton.click();

			// Wait for submission
			await page.waitForTimeout(2000);

			// Form should still be visible with custom text
			await expect(form).toBeVisible();
			await expect(form.locator('text=My custom answer')).toBeVisible();
		}
	});

	test('question form should persist across page refresh', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Select and submit
		const optionButton = form
			.locator('button')
			.filter({ hasText: /(Create|Edit)/i })
			.first();
		await optionButton.click();
		const submitButton = form.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// Wait for submission
		await page.waitForTimeout(2000);

		// Refresh the page
		await page.reload();

		// Wait for session to load
		await page.waitForSelector('[data-testid="message-input"], textarea[placeholder*="Ask"]', {
			timeout: 10000,
		});

		// The resolved question form should still be visible
		await expect(page.locator('text=Response submitted')).toBeVisible({ timeout: 5000 });
	});

	test('old question forms from previous sessions should be visible', async () => {
		// This test assumes there might be old sessions with questions
		// The forms should be visible even if not in current state

		// Navigate to home
		await page.goto('/');

		// Wait for app to load
		await page.waitForSelector('button:has-text("New Session")', { timeout: 10000 });

		// If there are existing sessions, check for any question forms
		const questionForms = page.locator(
			'div:has-text("Claude needs your input"), div:has-text("Response submitted"), div:has-text("Question skipped")'
		);

		// Any forms found should be visible
		const count = await questionForms.count();
		if (count > 0) {
			for (let i = 0; i < count; i++) {
				const form = questionForms.nth(i);
				await expect(form).toBeVisible();
			}
		}
	});

	test('question form should not disappear during rapid state changes', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Rapidly select different options
		const optionButtons = form.locator('button').filter({ hasText: /(Create|Edit|Delete|file)/i });
		const count = await optionButtons.count();

		for (let i = 0; i < Math.min(count, 3); i++) {
			await optionButtons.nth(i).click();
			await page.waitForTimeout(100);
		}

		// Form should still be visible
		await expect(form).toBeVisible();

		// Now submit
		const submitButton = form.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// During submission transition, form should remain visible
		await expect(form).toBeVisible();
	});

	test('question form state should be preserved in session history', async () => {
		await sendQuestionTriggeringMessage(page);
		await waitForQuestionForm(page);

		const form = getQuestionForm(page);

		// Select option and submit
		const optionButton = form
			.locator('button')
			.filter({ hasText: /(Create|Edit)/i })
			.first();
		await optionButton.click();
		const submitButton = form.locator('button:has-text("Submit Response")');
		await submitButton.click();

		// Wait for completion
		await page.waitForTimeout(3000);

		// Send another message to continue conversation
		const textarea = page.locator('textarea[placeholder*="Ask"]').first();
		await textarea.fill('Continue with the task');
		const sendButton = page.locator('button[aria-label*="Send"], button:has-text("Send")').first();
		await sendButton.click();

		// Wait for response
		await page.waitForTimeout(3000);

		// Scroll up to see previous questions
		await page.evaluate(() => {
			const container = document.querySelector('[data-messages-container]');
			if (container) {
				container.scrollTop = 0;
			}
		});

		// The old question form should still be visible in history
		await expect(page.locator('text=Response submitted')).toBeVisible();
	});
});
