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
import { useState, useCallback, useEffect } from 'preact/hooks';
import type { ContextInfo, ModelInfo, ThinkingLevel } from '@neokai/shared';
import { connectionState, type ConnectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import { useModal, MODEL_FAMILY_ICONS, useMessageHub } from '../hooks';
import { Spinner } from './ui/Spinner.tsx';
import { borderColors } from '../lib/design-tokens.ts';

/**
 * Thinking level display labels
 */
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	auto: 'Auto',
	think8k: 'Think 8k',
	think16k: 'Think 16k',
	think32k: 'Think 32k',
};

/**
 * ThinkingLevelIcon - Lightbulb icon with progressive lighting based on thinking level
 *
 * - auto: Dim (gray) - no glow
 * - think8k: 1/4 lit (amber glow, dim bulb)
 * - think16k: 1/2 lit (amber glow, medium bulb)
 * - think32k: Full lit (bright amber glow, bright bulb)
 */
function ThinkingLevelIcon({ level }: { level: ThinkingLevel }) {
	// Map level to brightness: 0 = off, 1 = 1/4, 2 = 1/2, 3 = full
	const brightness = level === 'auto' ? 0 : level === 'think8k' ? 1 : level === 'think16k' ? 2 : 3;

	// Color based on brightness level
	// auto: slightly brighter white, non-auto: progressive amber
	const strokeColor =
		brightness === 0
			? 'text-gray-400'
			: brightness === 1
				? 'text-amber-600'
				: brightness === 2
					? 'text-amber-500'
					: 'text-amber-400';

	// Fill opacity for the bulb (glow effect)
	const fillOpacity = brightness === 0 ? 0 : brightness === 1 ? 0.15 : brightness === 2 ? 0.3 : 0.5;

	return (
		<svg class={`w-4 h-4 ${strokeColor}`} viewBox="0 0 24 24">
			{/* Glow effect behind the bulb */}
			{brightness > 0 && (
				<circle
					cx="12"
					cy="10"
					r={brightness === 1 ? 4 : brightness === 2 ? 5 : 6}
					fill="currentColor"
					opacity={fillOpacity}
				/>
			)}
			{/* Lightbulb outline */}
			<path
				fill="none"
				stroke="currentColor"
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
			/>
		</svg>
	);
}

/**
 * ThinkingBorderRing - SVG ring that shows partial border lighting
 *
 * Uses stroke-dasharray to create partial circle effect:
 * - think8k: 1/4 of circle lit (90 degrees)
 * - think16k: 1/2 of circle lit (180 degrees)
 * - think32k: Full circle lit (360 degrees)
 */
function ThinkingBorderRing({ level }: { level: ThinkingLevel }) {
	if (level === 'auto') return null;

	// Circle parameters (matches w-8 h-8 = 32px button)
	const size = 32;
	const strokeWidth = 2;
	const radius = (size - strokeWidth) / 2; // 15
	const circumference = 2 * Math.PI * radius; // ~94.25

	// Calculate dash length based on level
	// 1/4 = 25%, 1/2 = 50%, full = 100%
	const dashPercent = level === 'think8k' ? 0.25 : level === 'think16k' ? 0.5 : 1;
	const dashLength = circumference * dashPercent;

	// Color based on level
	const strokeColor =
		level === 'think8k' ? '#d97706' : level === 'think16k' ? '#f59e0b' : '#fbbf24'; // amber-600, amber-500, amber-400

	return (
		<svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${size} ${size}`}>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={radius}
				fill="none"
				stroke={strokeColor}
				stroke-width={strokeWidth}
				stroke-dasharray={`${dashLength} ${circumference - dashLength}`}
				stroke-dashoffset={circumference * 0.25} // Start from top (rotate -90deg)
				stroke-linecap="round"
			/>
		</svg>
	);
}

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
	// Coordinator mode
	coordinatorMode: boolean;
	coordinatorSwitching?: boolean;
	onCoordinatorModeChange: (enabled: boolean) => void;
	// Thinking level
	thinkingLevel?: ThinkingLevel;
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
	coordinatorMode,
	coordinatorSwitching = false,
	onCoordinatorModeChange,
	thinkingLevel: thinkingLevelProp,
}: SessionStatusBarProps) {
	// Use useState + useSignalEffect to ensure component re-renders on signal change
	// This is more explicit than relying on implicit signal tracking
	const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

	useSignalEffect(() => {
		setConnState(connectionState.value);
	});

	// Get MessageHub for RPC calls
	const { callIfConnected } = useMessageHub();

	// Dropdowns - only one can be open at a time
	const modelDropdown = useModal();
	const thinkingDropdown = useModal();

	// Helper to toggle dropdown and close the other one
	const toggleModelDropdown = useCallback(() => {
		if (modelDropdown.isOpen) {
			modelDropdown.close();
		} else {
			thinkingDropdown.close();
			modelDropdown.open();
		}
	}, [modelDropdown, thinkingDropdown]);

	const toggleThinkingDropdown = useCallback(() => {
		if (thinkingDropdown.isOpen) {
			thinkingDropdown.close();
		} else {
			modelDropdown.close();
			thinkingDropdown.open();
		}
	}, [modelDropdown, thinkingDropdown]);

	// Thinking level state (synced from session config)
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(thinkingLevelProp || 'auto');

	// Sync thinking level with session config changes
	useEffect(() => {
		setThinkingLevel(thinkingLevelProp || 'auto');
	}, [thinkingLevelProp]);

	// Auto-scroll toggle handler
	const handleAutoScrollToggle = useCallback(() => {
		onAutoScrollChange(!autoScroll);
	}, [autoScroll, onAutoScrollChange]);

	// Coordinator mode toggle handler
	const handleCoordinatorModeToggle = useCallback(() => {
		onCoordinatorModeChange(!coordinatorMode);
	}, [coordinatorMode, onCoordinatorModeChange]);

	// Model switch handler
	const handleModelSwitch = useCallback(
		async (modelId: string) => {
			await onModelSwitch(modelId);
			modelDropdown.close();
		},
		[onModelSwitch, modelDropdown]
	);

	// Thinking level change handler with persistence
	const handleThinkingLevelChange = useCallback(
		async (level: ThinkingLevel) => {
			setThinkingLevel(level);
			thinkingDropdown.close();

			// Persist to session config via RPC
			await callIfConnected('session.thinking.set', {
				sessionId: _sessionId,
				level,
			});
		},
		[_sessionId, callIfConnected, thinkingDropdown]
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

			{/* Right: Interactive controls and context usage */}
			<div class="flex items-center gap-3 sm:gap-4">
				{/* Coordinator Mode Toggle */}
				<button
					class={`control-btn w-8 h-8 flex items-center justify-center bg-dark-700 hover:bg-dark-600 rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
						coordinatorMode ? 'border-2 border-purple-500' : 'border border-gray-600'
					}`}
					onClick={handleCoordinatorModeToggle}
					disabled={coordinatorSwitching || modelSwitching}
					title={`Coordinator Mode (${coordinatorMode ? 'enabled' : 'disabled'})`}
				>
					{coordinatorSwitching ? (
						<Spinner size="sm" />
					) : (
						<svg
							class={`w-4 h-4 transition-colors ${coordinatorMode ? 'text-purple-400' : 'text-gray-500'}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
							/>
						</svg>
					)}
				</button>

				{/* Model Switcher */}
				<div class="relative">
					<button
						class="control-btn w-8 h-8 flex items-center justify-center bg-dark-700 hover:bg-dark-600 border border-gray-600 sm:border-gray-600 rounded-full transition-colors text-lg disabled:opacity-50 disabled:cursor-not-allowed"
						onClick={toggleModelDropdown}
						disabled={modelLoading || modelSwitching || coordinatorSwitching}
						title={currentModelInfo ? `Switch Model (${currentModelInfo.name})` : 'Switch Model'}
					>
						{modelSwitching ? <Spinner size="sm" /> : currentModelIcon}
					</button>

					{/* Model Dropdown */}
					{modelDropdown.isOpen && (
						<div
							class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-48 py-1 z-50 animate-slideIn`}
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

				{/* Thinking Level */}
				<div class="relative">
					<button
						class={`control-btn relative w-8 h-8 flex items-center justify-center bg-dark-700 hover:bg-dark-600 border rounded-full transition-colors ${
							thinkingLevel === 'auto' ? 'border-gray-600' : 'border-transparent'
						}`}
						onClick={toggleThinkingDropdown}
						title={`Thinking: ${THINKING_LEVEL_LABELS[thinkingLevel]}`}
					>
						<ThinkingBorderRing level={thinkingLevel} />
						<ThinkingLevelIcon level={thinkingLevel} />
					</button>

					{/* Thinking Dropdown */}
					{thinkingDropdown.isOpen && (
						<div
							class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-40 py-1 z-50 animate-slideIn`}
						>
							<div class="px-3 py-1.5 text-xs font-semibold text-gray-400">Thinking Level</div>
							{(['auto', 'think8k', 'think16k', 'think32k'] as const).map((level) => (
								<button
									key={level}
									class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
										level === thinkingLevel ? 'text-amber-400' : 'text-gray-200'
									}`}
									onClick={() => handleThinkingLevelChange(level)}
								>
									<ThinkingLevelIcon level={level} />
									{THINKING_LEVEL_LABELS[level]}
									{level === thinkingLevel && ' (current)'}
								</button>
							))}
						</div>
					)}
				</div>

				{/* Auto-scroll Toggle - Highlighted border and icon when active */}
				<button
					class={`control-btn w-8 h-8 flex items-center justify-center bg-dark-700 hover:bg-dark-600 rounded-full transition-all ${
						autoScroll ? 'border-2 border-emerald-500' : 'border border-gray-600'
					}`}
					onClick={handleAutoScrollToggle}
					title={`Auto-scroll (${autoScroll ? 'enabled' : 'disabled'})`}
				>
					<svg
						class={`w-4 h-4 transition-colors ${autoScroll ? 'text-emerald-400' : 'text-gray-500'}`}
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

				{/* Separator */}
				<div class="h-6 w-px bg-gray-600" />

				{/* Context usage */}
				<ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
			</div>
		</ContentContainer>
	);
}
