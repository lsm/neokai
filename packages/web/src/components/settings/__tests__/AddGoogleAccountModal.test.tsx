// @ts-nocheck
/**
 * Tests for AddGoogleAccountModal Component
 *
 * Covers the multi-step headless OAuth flow:
 * - Step 1 (url): Display auth URL and Open/Copy buttons
 * - Step 2 (code): Enter authorization code
 * - Step 3 (success): Account added confirmation
 * - Step 4 (error): Failure state with retry
 *
 * Key regression: "Try Again" after a failed exchange must return to the
 * url step (not the code step) so the user gets a fresh single-use code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';

vi.mock('../../ui/Button.tsx', () => ({
	Button: ({
		children,
		variant,
		size,
		onClick,
		disabled,
		loading,
	}: {
		children: import('preact').ComponentChildren;
		variant?: string;
		size?: string;
		onClick?: () => void;
		disabled?: boolean;
		loading?: boolean;
	}) => (
		<button
			data-testid={`button-${variant || 'primary'}-${size || 'md'}`}
			disabled={disabled || loading}
			onClick={onClick}
		>
			{loading && <span data-testid="button-loading">Loading...</span>}
			{children}
		</button>
	),
}));

import { AddGoogleAccountModal } from '../AddGoogleAccountModal.tsx';

const defaultProps = {
	authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
	flowId: 'flow-abc-123',
	onComplete: vi.fn(),
	onCancel: vi.fn(),
	onSubmitCode: vi.fn().mockResolvedValue({ success: true }),
};

describe('AddGoogleAccountModal', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		// jsdom exposes clipboard as a getter-only property; override via defineProperty
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		cleanup();
	});

	describe('URL step (initial)', () => {
		it('renders the auth URL and action buttons', () => {
			const { container } = render(<AddGoogleAccountModal {...defaultProps} />);
			expect(container.textContent).toContain('Add Google Account');
			expect(container.textContent).toContain(defaultProps.authUrl);
			expect(container.textContent).toContain('Open URL & Continue');
			expect(container.textContent).toContain('Copy URL');
		});

		it('advances to code step when "Open URL & Continue" is clicked', async () => {
			// window.open is not implemented in jsdom
			vi.spyOn(window, 'open').mockImplementation(() => null);

			const { container } = render(<AddGoogleAccountModal {...defaultProps} />);

			const openBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Open URL & Continue')
			);
			openBtn?.click();

			await waitFor(() => {
				expect(container.textContent).toContain('Authorization Code');
			});
		});
	});

	describe('Code step', () => {
		const renderAtCodeStep = async () => {
			vi.spyOn(window, 'open').mockImplementation(() => null);
			const utils = render(<AddGoogleAccountModal {...defaultProps} />);
			const openBtn = Array.from(utils.container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Open URL & Continue')
			);
			openBtn?.click();
			await waitFor(() => {
				expect(utils.container.textContent).toContain('Authorization Code');
			});
			return utils;
		};

		it('calls onSubmitCode with the entered code and flowId', async () => {
			const { container } = await renderAtCodeStep();

			const input = container.querySelector('input') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'my-auth-code' } });

			const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Add Account')
			);
			addBtn?.click();

			await waitFor(() => {
				expect(defaultProps.onSubmitCode).toHaveBeenCalledWith('my-auth-code', 'flow-abc-123');
			});
		});

		it('advances to success step on successful submission', async () => {
			defaultProps.onSubmitCode.mockResolvedValueOnce({ success: true });
			const { container } = await renderAtCodeStep();

			const input = container.querySelector('input') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'good-code' } });

			const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Add Account')
			);
			addBtn?.click();

			await waitFor(() => {
				expect(container.textContent).toContain('Account added successfully');
			});
		});

		it('advances to error step on failed submission', async () => {
			defaultProps.onSubmitCode.mockResolvedValueOnce({
				success: false,
				error: 'Token exchange failed: invalid_grant',
			});
			const { container } = await renderAtCodeStep();

			const input = container.querySelector('input') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'bad-code' } });

			const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Add Account')
			);
			addBtn?.click();

			await waitFor(() => {
				expect(container.textContent).toContain('Failed to add account');
				expect(container.textContent).toContain('invalid_grant');
			});
		});
	});

	describe('Error step — "Try Again" restarts from url step', () => {
		const renderAtErrorStep = async () => {
			vi.spyOn(window, 'open').mockImplementation(() => null);
			defaultProps.onSubmitCode.mockResolvedValueOnce({
				success: false,
				error: 'Token exchange failed: invalid_grant',
			});
			const utils = render(<AddGoogleAccountModal {...defaultProps} />);

			// Navigate: url → code
			const openBtn = Array.from(utils.container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Open URL & Continue')
			);
			openBtn?.click();
			await waitFor(() => expect(utils.container.textContent).toContain('Authorization Code'));

			// Submit bad code → error step
			const input = utils.container.querySelector('input') as HTMLInputElement;
			fireEvent.input(input, { target: { value: 'bad-code' } });
			const addBtn = Array.from(utils.container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Add Account')
			);
			addBtn?.click();

			await waitFor(() => expect(utils.container.textContent).toContain('Failed to add account'));
			return utils;
		};

		it('shows "Try Again" and "Cancel" buttons on error', async () => {
			const { container } = await renderAtErrorStep();
			expect(container.textContent).toContain('Try Again');
			expect(container.textContent).toContain('Cancel');
		});

		it('"Try Again" returns to the url step (not the code step)', async () => {
			const { container } = await renderAtErrorStep();

			const tryAgainBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Try Again')
			);
			tryAgainBtn?.click();

			await waitFor(() => {
				// Should be back at the URL step
				expect(container.textContent).toContain('Open URL & Continue');
				expect(container.textContent).toContain(defaultProps.authUrl);
			});

			// Must NOT be showing the code input (would indicate landing on code step)
			expect(container.querySelector('input[id="gemini-auth-code"]')).toBeNull();
		});

		it('"Try Again" clears the auth code input for the next attempt', async () => {
			vi.spyOn(window, 'open').mockImplementation(() => null);
			const { container } = await renderAtErrorStep();

			const tryAgainBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Try Again')
			);
			tryAgainBtn?.click();

			// Advance to code step again
			await waitFor(() => expect(container.textContent).toContain('Open URL & Continue'));
			const openBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Open URL & Continue')
			);
			openBtn?.click();

			await waitFor(() => expect(container.textContent).toContain('Authorization Code'));
			const input = container.querySelector('input') as HTMLInputElement;
			// Input should be empty — cleared by "Try Again"
			expect(input.value).toBe('');
		});

		it('"Cancel" calls onCancel', async () => {
			const { container } = await renderAtErrorStep();

			const cancelBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Cancel'
			);
			cancelBtn?.click();

			expect(defaultProps.onCancel).toHaveBeenCalled();
		});
	});
});
