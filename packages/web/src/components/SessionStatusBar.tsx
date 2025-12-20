/**
 * SessionStatusBar Component
 *
 * Container component that displays both connection status and context usage
 * in a horizontal bar above the message input.
 *
 * Layout:
 * - Left: ConnectionStatus (Online/Offline/Connecting/Processing status)
 * - Right: ContextUsageBar (percentage + progress bar + dropdown)
 *
 * Uses the global connectionState signal directly for guaranteed reactivity.
 */

import { useSignalEffect } from '@preact/signals';
import { useState } from 'preact/hooks';
import type { ContextInfo } from '@liuboer/shared';
import { connectionState, type ConnectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';

interface SessionStatusBarProps {
	isProcessing: boolean;
	currentAction?: string;
	streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	contextUsage?: ContextInfo;
	maxContextTokens?: number;
}

export default function SessionStatusBar({
	isProcessing,
	currentAction,
	streamingPhase,
	contextUsage,
	maxContextTokens = 200000,
}: SessionStatusBarProps) {
	// Use useState + useSignalEffect to ensure component re-renders on signal change
	// This is more explicit than relying on implicit signal tracking
	const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

	useSignalEffect(() => {
		setConnState(connectionState.value);
	});

	return (
		<div class="px-4 pb-2">
			<div class="max-w-4xl mx-auto flex items-center gap-2 justify-between">
				{/* Left: Connection status */}
				<ConnectionStatus
					connectionState={connState}
					isProcessing={isProcessing}
					currentAction={currentAction}
					streamingPhase={streamingPhase}
				/>

				{/* Right: Context usage */}
				<ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
			</div>
		</div>
	);
}
