// @ts-nocheck
/**
 * Tests for GeminiAccountsPanel Component
 *
 * Tests the Google OAuth account management UI including:
 * - Account list display
 * - Status indicators
 * - Add account flow
 * - Remove account with confirmation
 * - Re-authenticate invalid accounts
 * - Summary stats and warnings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/preact';
import type { GeminiAccountInfo } from '@neokai/shared/provider';

const {
	mockListGeminiAccounts,
	mockStartGeminiOAuth,
	mockCompleteGeminiOAuth,
	mockRemoveGeminiAccount,
	mockToastError,
	mockToastSuccess,
} = vi.hoisted(() => ({
	mockListGeminiAccounts: vi.fn(),
	mockStartGeminiOAuth: vi.fn(),
	mockCompleteGeminiOAuth: vi.fn(),
	mockRemoveGeminiAccount: vi.fn(),
	mockToastError: vi.fn(),
	mockToastSuccess: vi.fn(),
}));

vi.mock('../../../lib/api-helpers.ts', () => ({
	listGeminiAccounts: () => mockListGeminiAccounts(),
	startGeminiOAuth: (accountId?: string) => mockStartGeminiOAuth(accountId),
	completeGeminiOAuth: (authCode: string, flowId: string) =>
		mockCompleteGeminiOAuth(authCode, flowId),
	removeGeminiAccount: (accountId: string) => mockRemoveGeminiAccount(accountId),
}));

vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		error: (msg: string) => mockToastError(msg),
		success: (msg: string) => mockToastSuccess(msg),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

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

vi.mock('../AddGoogleAccountModal.tsx', () => ({
	AddGoogleAccountModal: ({
		authUrl,
		flowId,
		onComplete,
		onCancel,
	}: {
		authUrl: string;
		flowId: string;
		onComplete: () => void;
		onCancel: () => void;
		onSubmitCode: (
			authCode: string,
			flowId: string
		) => Promise<{ success: boolean; error?: string }>;
	}) => (
		<div data-testid="add-account-modal">
			<span data-testid="modal-auth-url">{authUrl}</span>
			<span data-testid="modal-flow-id">{flowId}</span>
			<button data-testid="modal-complete-btn" onClick={onComplete}>
				Complete
			</button>
			<button data-testid="modal-cancel-btn" onClick={onCancel}>
				Cancel
			</button>
		</div>
	),
}));

import { GeminiAccountsPanel } from '../GeminiAccountsPanel.tsx';

const createMockAccount = (overrides: Partial<GeminiAccountInfo> = {}): GeminiAccountInfo => ({
	id: 'acc-1',
	email: 'test@gmail.com',
	status: 'active',
	addedAt: Date.now() - 86_400_000,
	lastUsedAt: Date.now() - 3600_000,
	dailyRequestCount: 342,
	dailyLimit: 1500,
	cooldownUntil: 0,
	...overrides,
});

describe('GeminiAccountsPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockListGeminiAccounts.mockResolvedValue({ accounts: [] });
		mockStartGeminiOAuth.mockResolvedValue({
			success: true,
			authUrl: 'https://mock-oauth.url',
			flowId: 'flow-123',
		});
		mockCompleteGeminiOAuth.mockResolvedValue({ success: true });
		mockRemoveGeminiAccount.mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		cleanup();
	});

	describe('Loading State', () => {
		it('shows loading state initially', async () => {
			let resolvePromise: (value: { accounts: GeminiAccountInfo[] }) => void;
			mockListGeminiAccounts.mockImplementation(
				() =>
					new Promise((resolve) => {
						resolvePromise = resolve;
					})
			);

			const { container } = render(<GeminiAccountsPanel />);
			expect(container.textContent).toContain('Loading accounts...');

			resolvePromise!({ accounts: [] });
			await waitFor(() => {
				expect(container.textContent).not.toContain('Loading accounts...');
			});
		});
	});

	describe('Empty State', () => {
		it('shows empty state when no accounts', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('No Google accounts added yet');
			});
		});
	});

	describe('Account List', () => {
		it('displays accounts with email and status', async () => {
			const accounts = [
				createMockAccount({ email: 'user1@gmail.com', status: 'active' }),
				createMockAccount({
					id: 'acc-2',
					email: 'user2@gmail.com',
					status: 'exhausted',
					dailyRequestCount: 1400,
				}),
			];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('user1@gmail.com');
				expect(container.textContent).toContain('user2@gmail.com');
				expect(container.textContent).toContain('Active');
				expect(container.textContent).toContain('Exhausted');
			});
		});

		it('shows daily usage counts', async () => {
			const accounts = [createMockAccount({ dailyRequestCount: 342, dailyLimit: 1500 })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('342 / 1,500 requests');
			});
		});

		it('shows summary stats', async () => {
			const accounts = [
				createMockAccount({ dailyRequestCount: 342, dailyLimit: 1500 }),
				createMockAccount({
					id: 'acc-2',
					email: 'user2@gmail.com',
					dailyRequestCount: 500,
					dailyLimit: 1500,
				}),
			];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('2 accounts');
				// remaining = 3000 - 842 = 2158
				expect(container.textContent).toContain('2,158 / 3,000 daily requests remaining');
			});
		});

		it('shows "Never" for unused accounts', async () => {
			const accounts = [createMockAccount({ lastUsedAt: 0 })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Never');
			});
		});
	});

	describe('Status Indicators', () => {
		it('shows invalid status with red badge', async () => {
			const accounts = [createMockAccount({ status: 'invalid' })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Invalid');
			});
		});

		it('shows exhausted status with cooldown time', async () => {
			const cooldownUntil = Date.now() + 180_000; // 3 minutes from now
			const accounts = [createMockAccount({ status: 'exhausted', cooldownUntil })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Exhausted');
				expect(container.textContent).toContain('cooldown');
			});
		});
	});

	describe('Warnings', () => {
		it('shows warning when all accounts exhausted', async () => {
			const accounts = [
				createMockAccount({ status: 'exhausted' }),
				createMockAccount({ id: 'acc-2', email: 'user2@gmail.com', status: 'invalid' }),
			];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('All accounts are exhausted or invalid');
			});
		});

		it('shows warning when only 1 active account', async () => {
			const accounts = [
				createMockAccount({ status: 'active' }),
				createMockAccount({ id: 'acc-2', email: 'user2@gmail.com', status: 'invalid' }),
			];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('no failover capacity');
			});
		});

		it('does not show warnings when multiple active accounts', async () => {
			vi.useRealTimers();
			const accounts = [
				createMockAccount({ status: 'active' }),
				createMockAccount({ id: 'acc-2', email: 'user2@gmail.com', status: 'active' }),
			];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('test@gmail.com');
			});

			expect(container.textContent).not.toContain('no failover capacity');
			expect(container.textContent).not.toContain('All accounts are exhausted');
			vi.useFakeTimers();
		});
	});

	describe('Add Account', () => {
		it('shows Add Google Account button', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Add Google Account');
			});
		});

		it('opens add account modal on click', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });
			mockStartGeminiOAuth.mockResolvedValue({
				success: true,
				authUrl: 'https://auth.url',
				flowId: 'flow-123',
			});

			const { container, getByTestId } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Add Google Account');
			});

			const addButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Add Google Account')
			);
			addButton?.click();

			await waitFor(() => {
				expect(getByTestId('add-account-modal')).toBeTruthy();
			});
		});

		it('shows error toast when startGeminiOAuth fails', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });
			mockStartGeminiOAuth.mockResolvedValue({
				success: false,
				error: 'Missing client ID',
			});

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Add Google Account');
			});

			const addButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Add Google Account')
			);
			addButton?.click();

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Missing client ID');
			});
		});

		it('shows error toast when flowId is missing from response', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });
			mockStartGeminiOAuth.mockResolvedValue({
				success: true,
				authUrl: 'https://auth.url',
				// flowId is missing
			});

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Add Google Account');
			});

			const addButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Add Google Account')
			);
			addButton?.click();

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to start OAuth flow');
			});
		});

		it('closes modal on cancel and reloads accounts', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });
			mockStartGeminiOAuth.mockResolvedValue({
				success: true,
				authUrl: 'https://auth.url',
				flowId: 'flow-123',
			});

			const { container, getByTestId, queryByTestId } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Add Google Account');
			});

			const addButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Add Google Account')
			);
			addButton?.click();

			await waitFor(() => {
				expect(getByTestId('add-account-modal')).toBeTruthy();
			});

			getByTestId('modal-cancel-btn').click();

			await waitFor(() => {
				expect(queryByTestId('add-account-modal')).toBeNull();
			});
		});
	});

	describe('Remove Account', () => {
		it('shows confirmation dialog on remove click', async () => {
			const accounts = [createMockAccount()];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('test@gmail.com');
			});

			// Find and click the remove button (trash icon button)
			const removeButton = container.querySelector('[data-testid="button-ghost-xs"]');
			if (removeButton) {
				removeButton.click();
			}

			await waitFor(() => {
				expect(container.textContent).toContain('Remove Google Account');
				expect(container.textContent).toContain('test@gmail.com');
			});
		});

		it('removes account and shows success toast on confirm', async () => {
			const accounts = [createMockAccount()];
			mockListGeminiAccounts.mockResolvedValue({ accounts });
			mockRemoveGeminiAccount.mockResolvedValue({ success: true });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('test@gmail.com');
			});

			// Click remove button
			const removeButton = container.querySelector('[data-testid="button-ghost-xs"]');
			if (removeButton) {
				removeButton.click();
			}

			await waitFor(() => {
				expect(container.textContent).toContain('Remove Google Account');
			});

			// Click confirm "Remove" button
			const confirmButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Remove')
			);
			confirmButton?.click();

			await waitFor(() => {
				expect(mockRemoveGeminiAccount).toHaveBeenCalledWith('acc-1');
				expect(mockToastSuccess).toHaveBeenCalledWith('Removed test@gmail.com');
			});
		});
	});

	describe('Re-authenticate', () => {
		it('shows Re-auth button for invalid accounts', async () => {
			const accounts = [createMockAccount({ status: 'invalid' })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Re-auth');
			});
		});

		it('does not show Re-auth button for active accounts', async () => {
			const accounts = [createMockAccount({ status: 'active' })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });

			const { container } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('test@gmail.com');
			});

			expect(container.textContent).not.toContain('Re-auth');
		});

		it('starts re-auth flow when Re-auth clicked', async () => {
			const accounts = [createMockAccount({ status: 'invalid' })];
			mockListGeminiAccounts.mockResolvedValue({ accounts });
			mockStartGeminiOAuth.mockResolvedValue({
				success: true,
				authUrl: 'https://reauth.url',
				flowId: 'reauth-flow-123',
			});

			const { container, getByTestId } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(container.textContent).toContain('Re-auth');
			});

			const reauthButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Re-auth')
			);
			reauthButton?.click();

			await waitFor(() => {
				expect(mockStartGeminiOAuth).toHaveBeenCalledWith('acc-1');
				expect(getByTestId('add-account-modal')).toBeTruthy();
			});
		});
	});

	describe('Auto-refresh', () => {
		it('sets up auto-refresh interval', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });

			render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(mockListGeminiAccounts).toHaveBeenCalledTimes(1);
			});

			// Advance time by 30 seconds
			vi.advanceTimersByTime(30_000);

			await waitFor(() => {
				expect(mockListGeminiAccounts).toHaveBeenCalledTimes(2);
			});
		});

		it('clears auto-refresh on unmount', async () => {
			mockListGeminiAccounts.mockResolvedValue({ accounts: [] });

			const { unmount } = render(<GeminiAccountsPanel />);

			await waitFor(() => {
				expect(mockListGeminiAccounts).toHaveBeenCalledTimes(1);
			});

			unmount();

			// Advance time - should not trigger another call
			vi.advanceTimersByTime(60_000);

			// Only called once (initial load)
			expect(mockListGeminiAccounts).toHaveBeenCalledTimes(1);
		});
	});
});
