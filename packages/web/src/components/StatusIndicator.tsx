/**
 * StatusIndicator Component
 *
 * Shows daemon connection and processing status above the message input
 * - Connecting: Yellow dot + "Connecting..."
 * - Connected: Green dot + "Online"
 * - Disconnected: Gray dot + "Offline"
 * - Processing: Pulsing purple dot + dynamic verb (e.g., "Reading files...", "Thinking...")
 * - Shows context usage percentage on the right
 */

import { useState, useRef, useEffect } from 'preact/hooks';
import type { ContextInfo } from '@liuboer/shared';

interface StatusIndicatorProps {
	connectionState: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';
	isProcessing: boolean;
	currentAction?: string;
	streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	contextUsage?: ContextInfo;
	maxContextTokens?: number;
	onSendMessage?: (message: string) => void;
}

export default function StatusIndicator({
	connectionState,
	isProcessing,
	currentAction,
	streamingPhase,
	contextUsage,
	maxContextTokens = 200000, // Default to Sonnet 4.5's 200k context window
	onSendMessage: _onSendMessage,
}: StatusIndicatorProps) {
	const [showContextDetails, setShowContextDetails] = useState(false);
	const [dropdownBottom, setDropdownBottom] = useState(96); // Default 24*4px = 96px
	const indicatorRef = useRef<HTMLDivElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Calculate dropdown position dynamically when it opens
	useEffect(() => {
		if (showContextDetails && indicatorRef.current && dropdownRef.current) {
			const indicatorRect = indicatorRef.current.getBoundingClientRect();
			const dropdownHeight = dropdownRef.current.offsetHeight;

			// Calculate space needed: height of dropdown + some padding (16px)
			const _spaceNeeded = dropdownHeight + 16;

			// Position dropdown above the indicator with proper spacing
			const bottomPosition = window.innerHeight - indicatorRect.top + 8;

			setDropdownBottom(bottomPosition);
		}
	}, [showContextDetails]);

	const getStatus = () => {
		// Processing state takes priority with phase-specific colors
		if (isProcessing && currentAction) {
			// Phase-specific color coding
			let dotClass = 'bg-purple-500 animate-pulse';
			let textClass = 'text-purple-400';

			if (streamingPhase) {
				switch (streamingPhase) {
					case 'initializing':
						dotClass = 'bg-yellow-500 animate-pulse';
						textClass = 'text-yellow-400';
						break;
					case 'thinking':
						dotClass = 'bg-blue-500 animate-pulse';
						textClass = 'text-blue-400';
						break;
					case 'streaming':
						dotClass = 'bg-green-500 animate-pulse';
						textClass = 'text-green-400';
						break;
					case 'finalizing':
						dotClass = 'bg-purple-500 animate-pulse';
						textClass = 'text-purple-400';
						break;
				}
			}

			return {
				dotClass,
				text: currentAction,
				textClass,
			};
		}

		// Connection states
		if (connectionState === 'connected') {
			return {
				dotClass: 'bg-green-500',
				text: 'Online',
				textClass: 'text-green-400',
			};
		}

		if (connectionState === 'connecting') {
			return {
				dotClass: 'bg-yellow-500 animate-pulse',
				text: 'Connecting...',
				textClass: 'text-yellow-400',
			};
		}

		// disconnected
		return {
			dotClass: 'bg-gray-500',
			text: 'Offline',
			textClass: 'text-gray-500',
		};
	};

	const status = getStatus();

	// Only show context info when accurate data is available
	const totalTokens = contextUsage?.totalUsed || 0;
	const contextCapacity = contextUsage?.totalCapacity || maxContextTokens;
	const contextPercentage = contextUsage?.percentUsed || 0;

	// Determine color based on usage - green for lower usage
	const getContextColor = () => {
		if (contextPercentage >= 90) return 'text-red-400';
		if (contextPercentage >= 70) return 'text-yellow-400';
		if (contextPercentage >= 50) return 'text-blue-400';
		return 'text-green-400';
	};

	const getContextBarColor = () => {
		if (contextPercentage >= 90) return 'bg-red-500';
		if (contextPercentage >= 70) return 'bg-yellow-500';
		if (contextPercentage >= 50) return 'bg-blue-500';
		return 'bg-green-500';
	};

	/**
	 * Get color for a specific context category
	 */
	const getCategoryColor = (category: string): { bg: string; text: string; dot: string } => {
		const normalizedCategory = category.toLowerCase();

		if (
			normalizedCategory.includes('input context') ||
			normalizedCategory.includes('input tokens')
		) {
			return { bg: 'bg-blue-500', text: 'text-blue-400', dot: 'bg-blue-400' };
		}
		if (normalizedCategory.includes('output tokens') || normalizedCategory.includes('output')) {
			return { bg: 'bg-green-500', text: 'text-green-400', dot: 'bg-green-400' };
		}
		if (normalizedCategory.includes('free space')) {
			return { bg: 'bg-gray-700', text: 'text-gray-500', dot: 'bg-gray-500' };
		}
		// Default color for unknown categories
		return { bg: 'bg-indigo-500', text: 'text-indigo-400', dot: 'bg-indigo-400' };
	};

	/**
	 * Get sort order for context categories
	 */
	const getCategorySortOrder = (category: string): number => {
		const normalizedCategory = category.toLowerCase();

		if (normalizedCategory.includes('input context') || normalizedCategory.includes('input tokens'))
			return 1;
		if (normalizedCategory.includes('output tokens') || normalizedCategory.includes('output'))
			return 2;
		if (normalizedCategory.includes('free space')) return 3;

		return 99; // Unknown categories go last
	};

	return (
		<>
			<div ref={indicatorRef} class="px-4 pb-2">
				<div class="max-w-4xl mx-auto flex items-center gap-2 justify-between">
					{/* Status indicator */}
					<div class="flex items-center gap-2">
						<div class={`w-2 h-2 rounded-full ${status.dotClass}`} />
						<span class={`text-xs font-medium ${status.textClass}`}>{status.text}</span>
					</div>

					{/* Context usage indicator - always show */}
					<div
						class="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
						onClick={() => totalTokens > 0 && setShowContextDetails(!showContextDetails)}
						title={totalTokens > 0 ? 'Click for context details' : 'Context data loading...'}
					>
						<span class={`text-xs font-medium ${getContextColor()}`}>
							{contextPercentage.toFixed(1)}%
						</span>
						<div class="w-24 sm:w-32 h-2 bg-dark-700 rounded-full overflow-hidden">
							<div
								class={`h-full transition-all duration-300 ${getContextBarColor()}`}
								style={{ width: `${Math.min(contextPercentage, 100)}%` }}
							/>
						</div>
					</div>
				</div>
			</div>

			{/* Context Details Dropdown */}
			{showContextDetails && totalTokens > 0 && (
				<>
					{/* Backdrop to close dropdown */}
					<div class="fixed inset-0 z-40" onClick={() => setShowContextDetails(false)} />

					{/* Dropdown positioned above the indicator */}
					<div
						class="fixed right-0 px-4 pointer-events-none"
						style={{ bottom: `${dropdownBottom}px` }}
					>
						<div class="max-w-4xl mx-auto flex justify-end">
							<div ref={dropdownRef} class="z-50 pointer-events-auto">
								<div class="bg-dark-800 border border-dark-600 rounded-lg p-4 w-72 shadow-xl">
									<div class="flex items-center justify-between mb-3">
										<h3 class="text-sm font-semibold text-gray-200">Context Usage</h3>
										<button
											class="text-gray-400 hover:text-gray-200 transition-colors"
											onClick={() => setShowContextDetails(false)}
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												class="w-4 h-4"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											>
												<line x1="18" y1="6" x2="6" y2="18"></line>
												<line x1="6" y1="6" x2="18" y2="18"></line>
											</svg>
										</button>
									</div>

									<div class="space-y-3">
										{/* Total Usage */}
										<div class="bg-dark-700 rounded-lg p-2.5">
											<div class="flex justify-between items-center mb-1.5">
												<span class="text-xs text-gray-400">Context Window</span>
												<span class={`text-xs font-semibold ${getContextColor()}`}>
													{contextPercentage.toFixed(1)}%
												</span>
											</div>
											<div class="w-full h-2.5 bg-dark-600 rounded-full overflow-hidden">
												<div
													class={`h-full transition-all duration-300 ${getContextBarColor()}`}
													style={{ width: `${Math.min(contextPercentage, 100)}%` }}
												/>
											</div>
											<div class="text-xs text-gray-500 mt-1">
												{totalTokens.toLocaleString()} / {contextCapacity.toLocaleString()}
											</div>
										</div>

										{/* Token Breakdown with colored squares */}
										{contextUsage?.breakdown && (
											<div class="space-y-2">
												<h4 class="text-xs font-medium text-gray-300">Breakdown</h4>
												<div class="space-y-1.5">
													{Object.entries(contextUsage.breakdown)
														.sort(
															([categoryA], [categoryB]) =>
																getCategorySortOrder(categoryA) - getCategorySortOrder(categoryB)
														)
														.map(([category, data]) => {
															const { bg, text } = getCategoryColor(category);
															const percentage =
																data.percent !== null
																	? data.percent
																	: (data.tokens / contextCapacity) * 100;
															return (
																<div key={category} class="flex items-center gap-2 text-xs">
																	{/* Colored square icon */}
																	<div class={`w-3 h-3 rounded ${bg} flex-shrink-0`} />
																	<span class="text-gray-400 flex-1 min-w-0 truncate">
																		{category}
																	</span>
																	<span class={`${text} font-medium`}>
																		{percentage.toFixed(1)}%
																	</span>
																	<span class="text-gray-200 font-mono text-xs">
																		{data.tokens.toLocaleString()}
																	</span>
																</div>
															);
														})}
												</div>
											</div>
										)}

										{/* Model info */}
										{contextUsage?.model && (
											<div class="pt-3 border-t border-dark-700">
												<div class="flex items-center gap-2 text-xs">
													<svg
														class="w-3.5 h-3.5 text-gray-400"
														fill="none"
														viewBox="0 0 24 24"
														stroke="currentColor"
													>
														<path
															stroke-linecap="round"
															stroke-linejoin="round"
															stroke-width={2}
															d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
														/>
													</svg>
													<span class="text-gray-400">Model:</span>
													<span class="text-gray-200 font-mono">{contextUsage.model}</span>
												</div>
											</div>
										)}
									</div>
								</div>
							</div>
						</div>
					</div>
				</>
			)}
		</>
	);
}
