import { useEffect, useState } from 'preact/hooks';
import { copyToClipboard } from '../../../lib/utils';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { messageSpacing } from '../../../lib/design-tokens';

interface SpaceTaskThreadMessageActionsProps {
	timestamp: number;
	copyText: string;
	align?: 'left' | 'right';
	/**
	 * When provided, an additional icon button is rendered next to the copy
	 * action that opens the agent's full session in the slide-over chat
	 * overlay (scrolling to the corresponding message). Touch-friendly:
	 * always visible, no hover required.
	 */
	onOpenSession?: () => void;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	});
}

function formatFullTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}

export function SpaceTaskThreadMessageActions({
	timestamp,
	copyText,
	align = 'left',
	onOpenSession,
}: SpaceTaskThreadMessageActionsProps) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	const onCopy = async () => {
		const ok = await copyToClipboard(copyText);
		if (ok) setCopied(true);
	};

	return (
		<div
			class={`flex items-center ${messageSpacing.actions.gap} ${messageSpacing.actions.marginTop} ${messageSpacing.actions.padding} ${
				align === 'right' ? 'justify-end' : ''
			}`}
		>
			<Tooltip content={formatFullTime(timestamp)} position={align === 'right' ? 'left' : 'right'}>
				<span class="text-xs text-gray-500">{formatTime(timestamp)}</span>
			</Tooltip>

			<IconButton
				size="md"
				onClick={onCopy}
				title={copied ? 'Copied!' : 'Copy message'}
				class={copied ? 'text-green-400' : ''}
			>
				{copied ? (
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
					</svg>
				) : (
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
						/>
					</svg>
				)}
			</IconButton>

			{onOpenSession && (
				<IconButton size="md" onClick={onOpenSession} title="Open in session">
					{/* External-link / open-pane icon — signals "jump into the full session". */}
					<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M14 5l7 7m0 0l-7 7m7-7H3"
						/>
					</svg>
				</IconButton>
			)}
		</div>
	);
}
