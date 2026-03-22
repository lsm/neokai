/**
 * TaskActionDropdown Component
 *
 * A dropdown that combines task info and actions into a single compact UI element.
 *
 * Info section (compact):
 * - Worktree path (last 2 segments, full path on hover)
 * - Session IDs (worker/leader)
 * - Current model
 *
 * Actions section:
 * - Complete, Archive buttons (Cancel and Stop are standalone outside dropdown)
 * - Context-aware: hides actions not applicable to current task state
 */

import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { borderColors } from '../../lib/design-tokens.ts';
import { getModelLabel } from '../../lib/session-utils.ts';
import { CopyButton } from '../ui/CopyButton.tsx';
import type { SessionInfo } from '@neokai/shared';

/**
 * Get the last N segments of a path
 */
function getLastPathSegments(path: string, segments: number = 2): string {
	if (!path) return '';
	const parts = path.split('/');
	if (parts.length <= segments) return path;
	return '.../' + parts.slice(-segments).join('/');
}

export interface TaskActionDropdownAction {
	id: string;
	label: string;
	icon?: 'complete' | 'archive';
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
}

export interface TaskActionDropdownProps {
	/** Worktree path to display (full path shown on hover) */
	worktreePath?: string;
	/** Worker session info */
	workerSession?: SessionInfo | null;
	/** Leader session info */
	leaderSession?: SessionInfo | null;
	/** Available actions - component determines which to show based on context */
	actions: {
		onComplete?: () => void;
		onArchive?: () => void;
	};
	/** Whether each action should be shown (context-aware) */
	visibleActions: {
		complete?: boolean;
		archive?: boolean;
	};
	/** Whether each action is disabled */
	disabledActions?: {
		complete?: boolean;
		archive?: boolean;
	};
	/** Additional CSS class */
	class?: string;
}

export function TaskActionDropdown({
	worktreePath,
	workerSession,
	leaderSession,
	actions,
	visibleActions,
	disabledActions,
	class: className,
}: TaskActionDropdownProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [dropdownBottom, setDropdownBottom] = useState(56); // Default position
	const triggerRef = useRef<HTMLDivElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const closeDropdown = useCallback(() => {
		setIsOpen(false);
	}, []);

	// Handle escape key and click outside
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				closeDropdown();
			}
		};

		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target as Node;
			const isInsideDropdown = dropdownRef.current?.contains(target);
			const isInsideTrigger = triggerRef.current?.contains(target);

			if (!isInsideDropdown && !isInsideTrigger) {
				closeDropdown();
			}
		};

		document.addEventListener('keydown', handleEscape, true);
		const timeoutId = setTimeout(() => {
			document.addEventListener('click', handleClickOutside, true);
		}, 0);

		return () => {
			document.removeEventListener('keydown', handleEscape, true);
			document.removeEventListener('click', handleClickOutside, true);
			clearTimeout(timeoutId);
		};
	}, [isOpen, closeDropdown]);

	// Calculate dropdown position
	useEffect(() => {
		if (!isOpen || !triggerRef.current) return;

		const updatePosition = () => {
			if (triggerRef.current) {
				const triggerRect = triggerRef.current.getBoundingClientRect();
				setDropdownBottom(window.innerHeight - triggerRect.top + 8);
			}
		};

		updatePosition();
		window.addEventListener('resize', updatePosition);
		return () => window.removeEventListener('resize', updatePosition);
	}, [isOpen]);

	// Build action items for the dropdown (Complete, Archive - Cancel and Stop are standalone)
	const actionItems: TaskActionDropdownAction[] = [];

	if (visibleActions.complete && actions.onComplete) {
		actionItems.push({
			id: 'complete',
			label: 'Complete',
			icon: 'complete',
			onClick: actions.onComplete,
			disabled: disabledActions?.complete,
		});
	}

	if (visibleActions.archive && actions.onArchive) {
		actionItems.push({
			id: 'archive',
			label: 'Archive',
			icon: 'archive',
			onClick: actions.onArchive,
			disabled: disabledActions?.archive,
			danger: true,
		});
	}

	// Get icon for action
	const getActionIcon = (icon: TaskActionDropdownAction['icon']) => {
		switch (icon) {
			case 'complete':
				return (
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 13l4 4L19 7"
						/>
					</svg>
				);
			case 'archive':
				return (
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 13a2 2 0 002 2h8a2 2 0 002-2L19 8"
						/>
					</svg>
				);
			default:
				return null;
		}
	};

	// Determine if there's any info to show
	const hasWorktreeInfo = worktreePath || workerSession || leaderSession;
	const displayPath = worktreePath ? getLastPathSegments(worktreePath) : null;

	return (
		<>
			{/* Trigger button */}
			<div ref={triggerRef} class={`relative ${className}`}>
				<button
					class={`p-1.5 rounded transition-colors ${
						isOpen
							? 'bg-blue-600 text-white'
							: 'text-gray-400 hover:text-gray-200 hover:bg-dark-700'
					}`}
					onClick={() => setIsOpen(!isOpen)}
					title="Task actions and info"
					data-testid="task-action-dropdown-trigger"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
				</button>
			</div>

			{/* Dropdown */}
			{isOpen && (
				<div class="fixed right-0 px-4 z-50" style={{ bottom: `${dropdownBottom}px` }}>
					<div class="max-w-4xl mx-auto flex justify-end">
						<div ref={dropdownRef}>
							<div
								class={`bg-dark-850 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-72`}
							>
								{/* Info section */}
								{hasWorktreeInfo && (
									<div class="p-3 border-b border-dark-700">
										<h3 class="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
											Info
										</h3>
										<div class="space-y-2 text-xs">
											{/* Worktree path */}
											{worktreePath && (
												<div class="flex items-center gap-2">
													<span class="text-gray-500 flex-shrink-0">Path:</span>
													<span
														class="text-gray-300 font-mono truncate flex-1"
														title={worktreePath}
													>
														{displayPath}
													</span>
													<CopyButton text={worktreePath} />
												</div>
											)}

											{/* Session IDs */}
											{(workerSession || leaderSession) && (
												<div class="space-y-1">
													{workerSession && (
														<div class="flex items-center gap-2">
															<span class="text-gray-500 flex-shrink-0">Worker:</span>
															<span
																class="text-gray-300 font-mono truncate flex-1"
																title={workerSession.id}
															>
																{workerSession.id.slice(0, 8)}...
															</span>
															<CopyButton text={workerSession.id} />
														</div>
													)}
													{leaderSession && (
														<div class="flex items-center gap-2">
															<span class="text-gray-500 flex-shrink-0">Leader:</span>
															<span
																class="text-gray-300 font-mono truncate flex-1"
																title={leaderSession.id}
															>
																{leaderSession.id.slice(0, 8)}...
															</span>
															<CopyButton text={leaderSession.id} />
														</div>
													)}
												</div>
											)}

											{/* Model info */}
											{(workerSession?.config.model || leaderSession?.config.model) && (
												<div class="flex items-center gap-2">
													<span class="text-gray-500 flex-shrink-0">Model:</span>
													<span class="text-gray-300">
														{getModelLabel(
															workerSession?.config.model ?? leaderSession?.config.model
														)}
													</span>
												</div>
											)}
										</div>
									</div>
								)}

								{/* Actions section */}
								{actionItems.length > 0 && (
									<div class="p-2">
										<h3 class="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide px-2">
											Actions
										</h3>
										<div class="space-y-1">
											{actionItems.map((action) => (
												<button
													key={action.id}
													onClick={() => {
														if (!action.disabled) {
															action.onClick();
															closeDropdown();
														}
													}}
													disabled={action.disabled}
													class={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
														action.disabled
															? 'text-gray-600 cursor-not-allowed'
															: action.danger
																? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
																: 'text-gray-300 hover:bg-dark-800 hover:text-gray-100'
													}`}
													data-testid={`task-action-${action.id}`}
												>
													<span class="w-4 h-4 flex-shrink-0">{getActionIcon(action.icon)}</span>
													<span>{action.label}</span>
												</button>
											))}
										</div>
									</div>
								)}

								{/* Empty state */}
								{!hasWorktreeInfo && actionItems.length === 0 && (
									<div class="p-4 text-center text-xs text-gray-500">No actions available</div>
								)}
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
