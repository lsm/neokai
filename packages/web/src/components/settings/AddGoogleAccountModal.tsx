import { useState } from 'preact/hooks';
import { Button } from '../ui/Button.tsx';

type Step = 'url' | 'code' | 'success' | 'error';

interface AddGoogleAccountModalProps {
	authUrl: string;
	flowId: string;
	onComplete: () => void;
	onCancel: () => void;
	onSubmitCode: (authCode: string, flowId: string) => Promise<{ success: boolean; error?: string }>;
}

export function AddGoogleAccountModal({
	authUrl,
	flowId,
	onComplete,
	onCancel,
	onSubmitCode,
}: AddGoogleAccountModalProps) {
	const [step, setStep] = useState<Step>('url');
	const [authCode, setAuthCode] = useState('');
	const [urlCopied, setUrlCopied] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState('');

	const copyUrl = async () => {
		try {
			await navigator.clipboard.writeText(authUrl);
			setUrlCopied(true);
			setTimeout(() => setUrlCopied(false), 2000);
		} catch {
			// Clipboard API not available
		}
	};

	const openAuthUrl = () => {
		window.open(authUrl, '_blank');
		setStep('code');
	};

	const handleSubmitCode = async () => {
		if (!authCode.trim()) return;

		setSubmitting(true);
		setErrorMessage('');

		try {
			const result = await onSubmitCode(authCode.trim(), flowId);
			if (result.success) {
				setStep('success');
				setTimeout(onComplete, 1500);
			} else {
				setStep('error');
				setErrorMessage(result.error || 'Failed to add account');
			}
		} catch (err) {
			setStep('error');
			setErrorMessage(err instanceof Error ? err.message : 'Failed to add account');
		} finally {
			setSubmitting(false);
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			onCancel();
		}
		if (e.key === 'Enter' && step === 'code' && authCode.trim()) {
			handleSubmitCode();
		}
	};

	return (
		<div class="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<div
				class="absolute inset-0 bg-black/60 backdrop-blur-sm cursor-pointer"
				onClick={onCancel}
			/>

			{/* Modal */}
			<div class="relative bg-dark-900 border border-dark-700 rounded-xl shadow-2xl max-w-lg w-full mx-4 p-6">
				{/* Header */}
				<div class="flex items-center justify-between mb-5">
					<h3 class="text-lg font-semibold text-gray-100">Add Google Account</h3>
					<button onClick={onCancel} class="text-gray-400 hover:text-gray-200 transition-colors">
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M6 18L18 6M6 6l12 12"
							/>
						</svg>
					</button>
				</div>

				{/* Step 1: Auth URL */}
				{step === 'url' && (
					<div class="space-y-4">
						<p class="text-sm text-gray-300">
							Visit the Google authorization URL below to get an authorization code. Log in with
							your Google account (Pro subscription required).
						</p>

						{/* Auth URL display */}
						<div class="bg-dark-800 border border-dark-700 rounded-lg p-3">
							<p class="text-xs text-gray-400 mb-2">Authorization URL:</p>
							<div class="flex items-start gap-2">
								<a
									href={authUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-blue-400 hover:text-blue-300 break-all flex-1"
								>
									{authUrl}
								</a>
							</div>
						</div>

						{/* Action buttons */}
						<div class="flex items-center gap-3">
							<Button variant="primary" size="sm" onClick={openAuthUrl}>
								<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width={2}
										d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
									/>
								</svg>
								Open URL & Continue
							</Button>
							<Button variant="secondary" size="sm" onClick={copyUrl}>
								{urlCopied ? (
									<>
										<svg
											class="w-4 h-4 mr-1.5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M5 13l4 4L19 7"
											/>
										</svg>
										Copied!
									</>
								) : (
									<>
										<svg
											class="w-4 h-4 mr-1.5"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width={2}
												d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
											/>
										</svg>
										Copy URL
									</>
								)}
							</Button>
						</div>

						<p class="text-xs text-gray-500">
							After authorizing, Google will display an authorization code. Copy it and paste it in
							the next step.
						</p>
					</div>
				)}

				{/* Step 2: Enter auth code */}
				{step === 'code' && (
					<div class="space-y-4">
						<p class="text-sm text-gray-300">
							Paste the authorization code from Google below. You can still{' '}
							<button onClick={openAuthUrl} class="text-blue-400 hover:text-blue-300 underline">
								open the URL
							</button>{' '}
							if you haven't visited it yet.
						</p>

						<div>
							<label for="gemini-auth-code" class="block text-sm font-medium text-gray-300 mb-1.5">
								Authorization Code
							</label>
							<input
								id="gemini-auth-code"
								type="text"
								value={authCode}
								onInput={(e) => setAuthCode((e.target as HTMLInputElement).value)}
								onKeyDown={handleKeyDown}
								placeholder="Paste your authorization code here..."
								class="w-full bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
								autoFocus
								spellcheck={false}
							/>
						</div>

						{errorMessage && <p class="text-sm text-red-400">{errorMessage}</p>}

						<div class="flex items-center gap-3">
							<Button
								variant="primary"
								size="sm"
								onClick={handleSubmitCode}
								loading={submitting}
								disabled={!authCode.trim() || submitting}
							>
								Add Account
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setStep('url')}>
								Back
							</Button>
						</div>
					</div>
				)}

				{/* Step 3: Success */}
				{step === 'success' && (
					<div class="space-y-4 text-center py-4">
						<svg
							class="w-12 h-12 text-green-400 mx-auto"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						<p class="text-sm text-green-400 font-medium">Account added successfully!</p>
					</div>
				)}

				{/* Step 4: Error */}
				{step === 'error' && (
					<div class="space-y-4">
						<div class="flex items-start gap-3">
							<svg
								class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width={2}
									d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<div>
								<p class="text-sm text-red-400 font-medium">Failed to add account</p>
								<p class="text-sm text-gray-400 mt-1">{errorMessage}</p>
							</div>
						</div>
						<div class="flex items-center gap-3">
							<Button variant="primary" size="sm" onClick={() => setStep('code')}>
								Try Again
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setStep('url')}>
								Start Over
							</Button>
						</div>
					</div>
				)}

				{/* Footer */}
				<div class="mt-6 pt-4 border-t border-dark-700 flex justify-end">
					<Button variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		</div>
	);
}
