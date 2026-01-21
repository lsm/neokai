import { useState } from 'preact/hooks';
import { copyToClipboard } from '../../lib/utils.ts';
import { toast } from '../../lib/toast.ts';

interface CopyButtonProps {
	text: string;
	label?: string;
	successMessage?: string;
}

export function CopyButton({
	text,
	label = 'Copy to clipboard',
	successMessage = 'Copied to clipboard',
}: CopyButtonProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		const success = await copyToClipboard(text);
		if (success) {
			setCopied(true);
			toast.success(successMessage);
			setTimeout(() => setCopied(false), 2000);
		} else {
			toast.error('Failed to copy');
		}
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			title={label}
			class="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-dark-700 rounded transition-colors"
		>
			{copied ? (
				<svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
				</svg>
			) : (
				<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					/>
				</svg>
			)}
		</button>
	);
}
