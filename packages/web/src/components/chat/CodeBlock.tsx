import { useState } from 'preact/hooks';
import { copyToClipboard } from '../../lib/utils.ts';
import { toast } from '../../lib/toast.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { borderColors } from '../../lib/design-tokens.ts';

interface CodeBlockProps {
	code: string;
	language?: string;
	filename?: string;
}

export default function CodeBlock({ code, language, filename }: CodeBlockProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		const success = await copyToClipboard(code);
		if (success) {
			setCopied(true);
			toast.success('Code copied to clipboard');
			setTimeout(() => setCopied(false), 2000);
		} else {
			toast.error('Failed to copy code');
		}
	};

	return (
		<div class={`relative group my-4 rounded-lg overflow-hidden border ${borderColors.ui.default}`}>
			{/* Header */}
			<div
				class={`flex items-center justify-between px-4 py-2 bg-dark-850 border-b ${borderColors.ui.default}`}
			>
				<div class="flex items-center gap-2">
					{filename && <span class="text-sm text-gray-300 font-medium">{filename}</span>}
					{language && !filename && <span class="text-xs text-gray-400 font-mono">{language}</span>}
				</div>
				<IconButton size="sm" onClick={handleCopy} title={copied ? 'Copied!' : 'Copy code'}>
					{copied ? (
						<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
							<path
								fill-rule="evenodd"
								d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
								clip-rule="evenodd"
							/>
						</svg>
					) : (
						<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
							/>
						</svg>
					)}
				</IconButton>
			</div>

			{/* Code */}
			<pre class="p-4 overflow-x-auto bg-dark-900">
				<code class={language ? `language-${language}` : ''}>{code}</code>
			</pre>
		</div>
	);
}
