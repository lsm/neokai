/**
 * SessionStatusBar Component
 *
 * Container component that displays connection status, interactive controls, and context usage
 * in a horizontal bar above the message input.
 *
 * Layout:
 * - Left: ConnectionStatus (Online/Offline/Connecting/Processing status)
 * - Center: Interactive controls (Model switcher, Auto-scroll, Thinking level)
 * - Right: ContextUsageBar (percentage + progress bar + dropdown)
 *
 * Uses the global connectionState signal directly for guaranteed reactivity.
 */

import { useSignalEffect } from '@preact/signals';
import { useState, useCallback } from 'preact/hooks';
import type { ContextInfo, ModelInfo } from '@liuboer/shared';
import { connectionState, type ConnectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import { useModal, MODEL_FAMILY_ICONS } from '../hooks';
import { Spinner } from './ui/Spinner.tsx';
import { borderColors } from '../lib/design-tokens.ts';

interface SessionStatusBarProps {
	sessionId: string;
	isProcessing: boolean;
	currentAction?: string;
	streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	contextUsage?: ContextInfo;
	maxContextTokens?: number;
	// Model switcher
	currentModel: string;
	currentModelInfo: ModelInfo | null;
	availableModels: ModelInfo[];
	modelSwitching: boolean;
	modelLoading: boolean;
	onModelSwitch: (modelId: string) => void;
	// Auto-scroll
	autoScroll: boolean;
	onAutoScrollChange: (enabled: boolean) => void;
}

export default function SessionStatusBar({
	sessionId: _sessionId,
	isProcessing,
	currentAction,
	streamingPhase,
	contextUsage,
	maxContextTokens = 200000,
	currentModel: _currentModel,
	currentModelInfo,
	availableModels,
	modelSwitching,
	modelLoading,
	onModelSwitch,
	autoScroll,
	onAutoScrollChange,
}: SessionStatusBarProps) {
	// Use useState + useSignalEffect to ensure component re-renders on signal change
	// This is more explicit than relying on implicit signal tracking
	const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

	useSignalEffect(() => {
		setConnState(connectionState.value);
	});

	// Dropdowns
	const modelDropdown = useModal();
	const thinkingDropdown = useModal();

	// Thinking level state (placeholder for now - TODO: integrate with session config)
	const [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'normal' | 'high'>('normal');

	// Auto-scroll toggle handler
	const handleAutoScrollToggle = useCallback(() => {
		onAutoScrollChange(!autoScroll);
	}, [autoScroll, onAutoScrollChange]);

	// Model switch handler
	const handleModelSwitch = useCallback(
		async (modelId: string) => {
			await onModelSwitch(modelId);
			modelDropdown.close();
		},
		[onModelSwitch, modelDropdown]
	);

	// Thinking level change handler
	const handleThinkingLevelChange = useCallback(
		(level: 'off' | 'low' | 'normal' | 'high') => {
			setThinkingLevel(level);
			thinkingDropdown.close();
			// TODO: Persist to session config
		},
		[thinkingDropdown]
	);

	// Get current model icon
	const currentModelIcon = currentModelInfo ? MODEL_FAMILY_ICONS[currentModelInfo.family] : '💎';

	return (
		<ContentContainer className="pb-2 flex items-center gap-4 justify-between">
			{/* Left: Connection status */}
			<ConnectionStatus
				connectionState={connState}
				isProcessing={isProcessing}
				currentAction={currentAction}
				streamingPhase={streamingPhase}
			/>

			{/* Center: Interactive controls */}
			<div class="flex items-center gap-4 sm:gap-2 flex-1 justify-center">
				{/* Model Switcher */}
				<div class="relative">
					<button
						class="control-btn w-7 h-7 flex items-center justify-center bg-dark-700 hover:bg-dark-600 border border-gray-600 sm:border-gray-600 rounded-md transition-colors text-lg disabled:opacity-50 disabled:cursor-not-allowed"
						onClick={modelDropdown.toggle}
						disabled={modelLoading || modelSwitching}
						title={currentModelInfo ? `Switch Model (${currentModelInfo.name})` : 'Switch Model'}
					>
						{modelSwitching ? <Spinner size="sm" /> : currentModelIcon}
					</button>

					{/* Model Dropdown */}
					{modelDropdown.isOpen && (
						<div
							class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-48 py-1 z-50`}
						>
							<div class="px-3 py-1.5 text-xs font-semibold text-gray-400">Select Model</div>
							{availableModels.map((model) => (
								<button
									key={model.id}
									class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
										model.id === currentModelInfo?.id ? 'text-blue-400' : 'text-gray-200'
									}`}
									onClick={() => handleModelSwitch(model.id)}
									disabled={modelSwitching}
								>
									<span class="text-base">{MODEL_FAMILY_ICONS[model.family]}</span>
									{model.name}
									{model.id === currentModelInfo?.id && ' (current)'}
								</button>
							))}
						</div>
					)}
				</div>

				{/* Auto-scroll Toggle */}
				<button
					class={`control-btn w-7 h-7 flex items-center justify-center bg-dark-700 hover:bg-dark-600 border border-gray-600 sm:border-gray-600 rounded-md transition-colors`}
					onClick={handleAutoScrollToggle}
					title={`Auto-scroll (${autoScroll ? 'enabled' : 'disabled'})`}
				>
					<svg
						class={`w-4 h-4 ${autoScroll ? 'text-green-400' : 'text-gray-500'}`}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M19 14l-7 7m0 0l-7-7m7 7V3"
						/>
					</svg>
				</button>

				{/* Thinking Level */}
				<div class="relative">
					<button
						class="control-btn w-7 h-7 flex items-center justify-center bg-dark-700 hover:bg-dark-600 border border-gray-600 sm:border-gray-600 rounded-md transition-colors"
						onClick={thinkingDropdown.toggle}
						title={`Thinking Level: ${thinkingLevel.charAt(0).toUpperCase() + thinkingLevel.slice(1)}`}
					>
						<svg
							class="w-4 h-4 text-gray-400"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
							/>
						</svg>
					</button>

					{/* Thinking Dropdown */}
					{thinkingDropdown.isOpen && (
						<div
							class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-40 py-1 z-50`}
						>
							<div class="px-3 py-1.5 text-xs font-semibold text-gray-400">Thinking Level</div>
							{(['off', 'low', 'normal', 'high'] as const).map((level) => (
								<button
									key={level}
									class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs ${
										level === thinkingLevel ? 'text-blue-400' : 'text-gray-200'
									}`}
									onClick={() => handleThinkingLevelChange(level)}
								>
									{level.charAt(0).toUpperCase() + level.slice(1)}
									{level === thinkingLevel && ' (current)'}
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Right: Context usage (hidden on mobile) */}
			<div class="hidden sm:flex">
				<ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
			</div>
		</ContentContainer>
	);
}
