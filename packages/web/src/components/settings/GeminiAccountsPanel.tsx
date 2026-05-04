import { useEffect, useState } from 'preact/hooks';
import { toast } from '../../lib/toast.ts';
import type { GeminiAccountInfo } from '@neokai/shared/provider';
import {
	listGeminiAccounts,
	startGeminiOAuth,
	completeGeminiOAuth,
	removeGeminiAccount,
} from '../../lib/api-helpers.ts';
import { Button } from '../ui/Button.tsx';
import { AddGoogleAccountModal } from './AddGoogleAccountModal.tsx';

/** Format a timestamp as a relative time string. */
function relativeTime(ts: number): string {
	if (ts === 0) return 'Never';
	const diff = Date.now() - ts;
	if (diff < 60_000) return 'Just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ts).toLocaleDateString();
}

/** Format daily usage with comma separators. */
function formatUsage(count: number, limit: number): string {
	return `${count.toLocaleString()} / ${limit.toLocaleString()} requests`;
}

/** Status dot color mapping. */
function statusColor(status: GeminiAccountInfo['status']): string {
	switch (status) {
		case 'active':
			return 'bg-green-400';
		case 'exhausted':
			return 'bg-amber-400';
		case 'invalid':
			return 'bg-red-400';
	}
}

/** Status label. */
function statusLabel(account: GeminiAccountInfo): string {
	switch (account.status) {
		case 'active':
			return 'Active';
		case 'exhausted': {
			if (account.cooldownUntil > 0) {
				const remaining = Math.max(0, account.cooldownUntil - Date.now());
				if (remaining > 0) {
					const mins = Math.ceil(remaining / 60_000);
					return `Exhausted (${mins}m cooldown)`;
				}
			}
			return 'Exhausted';
		}
		case 'invalid':
			return 'Invalid';
	}
}

/** Confirm dialog state. */
interface ConfirmState {
	open: boolean;
	title: string;
	message: string;
	onConfirm: () => void;
}

export function GeminiAccountsPanel() {
	const [accounts, setAccounts] = useState<GeminiAccountInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [showAddModal, setShowAddModal] = useState(false);
	const [oauthAuthUrl, setOauthAuthUrl] = useState('');
	const [oauthFlowId, setOauthFlowId] = useState('');
	const [startingOAuth, setStartingOAuth] = useState(false);
	const [confirm, setConfirm] = useState<ConfirmState>({
		open: false,
		title: '',
		message: '',
		onConfirm: () => {},
	});

	const loadAccounts = async () => {
		try {
			const response = await listGeminiAccounts();
			setAccounts(response.accounts);
		} catch {
			// Failed to load accounts
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadAccounts();
	}, []);

	// Auto-refresh accounts every 30 seconds
	useEffect(() => {
		const interval = setInterval(loadAccounts, 30_000);
		return () => clearInterval(interval);
	}, []);

	const handleAddAccount = async () => {
		setStartingOAuth(true);
		try {
			const response = await startGeminiOAuth();
			if (response.success && response.authUrl) {
				setOauthAuthUrl(response.authUrl);
				setOauthFlowId(response.message || '');
				setShowAddModal(true);
			} else {
				toast.error(response.error || 'Failed to start OAuth flow');
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start OAuth flow');
		} finally {
			setStartingOAuth(false);
		}
	};

	const handleReauth = async (account: GeminiAccountInfo) => {
		setStartingOAuth(true);
		try {
			const response = await startGeminiOAuth(account.id);
			if (response.success && response.authUrl) {
				setOauthAuthUrl(response.authUrl);
				setOauthFlowId(response.message || '');
				setShowAddModal(true);
			} else {
				toast.error(response.error || 'Failed to start re-authentication');
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to start re-authentication');
		} finally {
			setStartingOAuth(false);
		}
	};

	const handleSubmitCode = async (
		authCode: string,
		flowId: string
	): Promise<{ success: boolean; error?: string }> => {
		const response = await completeGeminiOAuth(authCode, flowId);
		if (response.success) {
			await loadAccounts();
		}
		return { success: response.success, error: response.error };
	};

	const handleRemoveAccount = (account: GeminiAccountInfo) => {
		setConfirm({
			open: true,
			title: 'Remove Google Account',
			message: `Remove ${account.email}? Any sessions using this account will failover to another.`,
			onConfirm: async () => {
				try {
					const response = await removeGeminiAccount(account.id);
					if (response.success) {
						toast.success(`Removed ${account.email}`);
						await loadAccounts();
					} else {
						toast.error(response.error || 'Failed to remove account');
					}
				} catch (err) {
					toast.error(err instanceof Error ? err.message : 'Failed to remove account');
				}
				setConfirm((prev) => ({ ...prev, open: false }));
			},
		});
	};

	// Summary stats
	const activeCount = accounts.filter((a) => a.status === 'active').length;
	const totalRequests = accounts.reduce((sum, a) => sum + a.dailyRequestCount, 0);
	const totalLimit = accounts.reduce((sum, a) => sum + a.dailyLimit, 0);
	const remaining = totalLimit - totalRequests;

	if (loading) {
		return <div class="text-gray-500 text-sm py-2">Loading accounts...</div>;
	}

	return (
		<div class="space-y-4">
			{/* Provider summary */}
			{accounts.length > 0 && (
				<div class="flex items-center gap-4 text-sm text-gray-400">
					<span>
						{accounts.length} account{accounts.length !== 1 ? 's' : ''}
					</span>
					<span class="text-gray-600">·</span>
					<span>
						{remaining.toLocaleString()} / {totalLimit.toLocaleString()} daily requests remaining
					</span>
				</div>
			)}

			{/* Warnings */}
			{accounts.length > 0 && activeCount === 0 && (
				<div class="flex items-start gap-2 p-3 bg-amber-900/30 border border-amber-700/50 rounded-lg">
					<svg
						class="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"
						/>
					</svg>
					<p class="text-sm text-amber-300">
						All accounts are exhausted or invalid. Add more accounts or wait for cooldown.
					</p>
				</div>
			)}
			{accounts.length > 0 && activeCount === 1 && (
				<div class="flex items-start gap-2 p-3 bg-yellow-900/20 border border-yellow-700/30 rounded-lg">
					<svg
						class="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<p class="text-sm text-yellow-300">
						Only 1 active account — no failover capacity. Consider adding another account.
					</p>
				</div>
			)}

			{/* Account list */}
			{accounts.length === 0 ? (
				<div class="text-gray-500 text-sm py-2">
					No Google accounts added yet. Add an account to use Gemini models via OAuth.
				</div>
			) : (
				<div class="space-y-2">
					{accounts.map((account) => (
						<div
							key={account.id}
							class="flex items-center justify-between p-3 bg-dark-800 rounded-lg border border-dark-700"
						>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span
										class={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor(account.status)}`}
									/>
									<span class="text-sm font-medium text-gray-200 truncate">{account.email}</span>
									<span
										class={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${
											account.status === 'active'
												? 'bg-green-900/50 text-green-400'
												: account.status === 'exhausted'
													? 'bg-amber-900/50 text-amber-400'
													: 'bg-red-900/50 text-red-400'
										}`}
									>
										{statusLabel(account)}
									</span>
								</div>
								<div class="flex items-center gap-3 mt-1 text-xs text-gray-500">
									<span>{formatUsage(account.dailyRequestCount, account.dailyLimit)}</span>
									<span>·</span>
									<span>Last used: {relativeTime(account.lastUsedAt)}</span>
								</div>
							</div>
							<div class="flex-shrink-0 ml-3 flex items-center gap-2">
								{account.status === 'invalid' && (
									<Button
										variant="warning"
										size="xs"
										onClick={() => handleReauth(account)}
										disabled={startingOAuth}
									>
										Re-auth
									</Button>
								)}
								<Button variant="ghost" size="xs" onClick={() => handleRemoveAccount(account)}>
									<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
										/>
									</svg>
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			{/* Add account button */}
			<Button
				variant="secondary"
				size="sm"
				onClick={handleAddAccount}
				loading={startingOAuth}
				disabled={startingOAuth}
			>
				<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width={2}
						d="M12 4v16m8-8H4"
					/>
				</svg>
				Add Google Account
			</Button>

			{/* Add Account Modal */}
			{showAddModal && (
				<AddGoogleAccountModal
					authUrl={oauthAuthUrl}
					flowId={oauthFlowId}
					onComplete={() => {
						setShowAddModal(false);
						loadAccounts();
						toast.success('Google account added successfully');
					}}
					onCancel={() => setShowAddModal(false)}
					onSubmitCode={handleSubmitCode}
				/>
			)}

			{/* Confirm Dialog */}
			{confirm.open && (
				<div class="fixed inset-0 z-50 flex items-center justify-center">
					<div
						class="absolute inset-0 bg-black/60 backdrop-blur-sm cursor-pointer"
						onClick={() => setConfirm((prev) => ({ ...prev, open: false }))}
					/>
					<div class="relative bg-dark-900 border border-dark-700 rounded-xl shadow-2xl max-w-sm w-full mx-4 p-6">
						<h3 class="text-lg font-semibold text-gray-100 mb-2">{confirm.title}</h3>
						<p class="text-sm text-gray-300 mb-5">{confirm.message}</p>
						<div class="flex justify-end gap-3">
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setConfirm((prev) => ({ ...prev, open: false }))}
							>
								Cancel
							</Button>
							<Button variant="danger" size="sm" onClick={confirm.onConfirm}>
								Remove
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
