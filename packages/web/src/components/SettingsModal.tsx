import { useEffect, useState } from 'preact/hooks';
import type { AuthStatus } from '@neokai/shared';
import { getAuthStatus } from '../lib/api-helpers.ts';
import { toast } from '../lib/toast.ts';
import { Modal } from './ui/Modal.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { GlobalToolsSettings } from './GlobalToolsSettings.tsx';
import { GlobalSettingsEditor } from './GlobalSettingsEditor.tsx';

interface SettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
	const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (isOpen) {
			loadAuthStatus();
		}
	}, [isOpen]);

	const loadAuthStatus = async () => {
		try {
			setLoading(true);
			const response = await getAuthStatus();
			setAuthStatus(response.authStatus);
		} catch (error) {
			toast.error('Failed to load authentication status');
		} finally {
			setLoading(false);
		}
	};

	return (
		<Modal isOpen={isOpen} onClose={onClose} title="Settings" size="md">
			<div class="space-y-6">
				{/* Current Auth Status */}
				{loading ? (
					<div class="text-center py-4">
						<div class="text-gray-400">Loading...</div>
					</div>
				) : authStatus ? (
					<div class="space-y-4">
						<div class={`bg-dark-800 rounded-lg p-4 border ${borderColors.ui.secondary}`}>
							<h3 class="text-sm font-medium text-gray-300 mb-3">Authentication Status</h3>

							{authStatus.isAuthenticated ? (
								<div class="space-y-2">
									<div class="flex items-center gap-2">
										<div class="w-2 h-2 bg-green-500 rounded-full" />
										<span class="text-sm text-gray-200">
											Authenticated via{' '}
											<span class="font-medium">
												{authStatus.method === 'oauth'
													? 'OAuth Flow'
													: authStatus.method === 'oauth_token'
														? 'OAuth Token'
														: 'API Key'}
											</span>
										</span>
									</div>
								</div>
							) : (
								<div class="flex items-center gap-2">
									<div class="w-2 h-2 bg-red-500 rounded-full" />
									<span class="text-sm text-gray-400">Not authenticated</span>
								</div>
							)}
						</div>

						{/* Instructions */}
						<div class="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
							<div class="flex items-start gap-3">
								<svg
									class="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5"
									fill="currentColor"
									viewBox="0 0 20 20"
								>
									<path
										fill-rule="evenodd"
										d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
										clip-rule="evenodd"
									/>
								</svg>
								<div class="flex-1">
									<h4 class="text-sm font-medium text-blue-300 mb-2">
										{authStatus?.isAuthenticated
											? 'Authentication Info'
											: 'How to Configure Authentication'}
									</h4>
									<div class="text-xs text-blue-200/80 space-y-2">
										{!authStatus?.isAuthenticated && (
											<>
												<div class="space-y-1">
													<p class="font-medium text-blue-200">
														Option 1: Claude Code Login (Recommended)
													</p>
													<p>If you have Claude Code CLI installed, log in and restart Kai:</p>
													<pre class="p-2 bg-dark-950 rounded border border-blue-500/20 text-blue-300 overflow-x-auto">
														<code>
															claude login{'\n'}# Then restart Kai to auto-detect credentials
														</code>
													</pre>
												</div>
												<div class="space-y-1">
													<p class="font-medium text-blue-200">Option 2: API Key</p>
													<pre class="p-2 bg-dark-950 rounded border border-blue-500/20 text-blue-300 overflow-x-auto">
														<code>export ANTHROPIC_API_KEY=sk-ant-...</code>
													</pre>
												</div>
												<div class="space-y-1">
													<p class="font-medium text-blue-200">
														Option 3: Third-Party Provider (Zhipu, etc.)
													</p>
													<p>
														Configure in <code class="text-blue-300">~/.claude/settings.json</code>:
													</p>
													<pre class="p-2 bg-dark-950 rounded border border-blue-500/20 text-blue-300 overflow-x-auto">
														<code>{`{ "env": { "ANTHROPIC_AUTH_TOKEN": "your_key", "ANTHROPIC_BASE_URL": "https://..." } }`}</code>
													</pre>
												</div>
											</>
										)}
										<p class="mt-2">
											{authStatus?.isAuthenticated
												? 'Credentials are auto-detected from Claude Code login, environment variables, or ~/.claude/settings.json.'
												: 'After configuring credentials, restart Kai for changes to take effect.'}
										</p>
									</div>
								</div>
							</div>
						</div>

						{/* Global Settings */}
						<div class={`bg-dark-800 rounded-lg p-4 border ${borderColors.ui.secondary}`}>
							<h3 class="text-sm font-medium text-gray-300 mb-3">Global Settings</h3>
							<GlobalSettingsEditor />
						</div>

						{/* Global Tools Settings */}
						<GlobalToolsSettings />
					</div>
				) : null}
			</div>
		</Modal>
	);
}
