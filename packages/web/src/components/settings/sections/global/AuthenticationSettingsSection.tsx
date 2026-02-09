/**
 * AuthenticationSettingsSection - Authentication settings
 *
 * Displays current authentication status and instructions.
 */

import { authStatus } from '../../../../lib/state.ts';

export function AuthenticationSettingsSection() {
	const auth = authStatus.value;

	return (
		<div class="space-y-6">
			<div class="rounded-lg border border-dark-700 bg-dark-800 p-4">
				<h3 class="mb-4 text-sm font-medium text-gray-200">Authentication Status</h3>
				<div class="space-y-3">
					{auth?.method === 'oauth' || auth?.method === 'oauth_token' ? (
						<div class="flex items-center gap-2 text-sm text-green-400">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<span>Authenticated via OAuth</span>
						</div>
					) : auth?.method === 'api_key' ? (
						<div class="flex items-center gap-2 text-sm text-green-400">
							<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<span>Authenticated via API Key</span>
						</div>
					) : (
						<div class="text-sm text-gray-400">Not authenticated</div>
					)}
				</div>
			</div>

			<div class="rounded-lg border border-dark-700 bg-dark-800/50 p-4">
				<h3 class="mb-2 text-sm font-medium text-gray-200">How to Configure</h3>
				<p class="text-xs text-gray-400">
					Set the <code class="rounded bg-dark-900 px-1 py-0.5">ANTHROPIC_API_KEY</code> environment
					variable, or sign in with OAuth in the CLI.
				</p>
			</div>
		</div>
	);
}
