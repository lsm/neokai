import type { MessageDeliveryMode, MessageImage } from '@neokai/shared';
import { useMemo, useState } from 'preact/hooks';
import { ChatComposer } from '../ChatComposer.tsx';
import { useModelSwitcher } from '../../hooks';
import { cn } from '../../lib/utils.ts';
import { getAgentColor } from './thread/space-task-thread-agent-colors';
import { agentInitial } from './thread/minimal/minimal-mock-data';

export interface TaskComposerTarget {
	id: string;
	kind: 'task_agent' | 'node_agent';
	label: string;
	agentName?: string;
	nodeExecutionId?: string;
	nodeName?: string;
	state?: string;
}

interface TaskSessionChatComposerProps {
	sessionId: string;
	mentionCandidates: Array<{ id: string; name: string }>;
	targets: TaskComposerTarget[];
	selectedTargetId: string | null;
	hasTaskAgentSession: boolean;
	canSend: boolean;
	isSending: boolean;
	isProcessing: boolean;
	autoScroll: boolean;
	errorMessage?: string | null;
	onAutoScrollChange: (enabled: boolean) => void;
	onTargetSelect: (targetId: string) => void;
	onDraftActiveChange?: (hasDraft: boolean) => void;
	onSend: (message: string, target: TaskComposerTarget | null) => Promise<boolean>;
}

export function TaskSessionChatComposer({
	sessionId,
	mentionCandidates,
	targets,
	selectedTargetId,
	hasTaskAgentSession,
	canSend,
	isSending,
	isProcessing,
	autoScroll,
	errorMessage,
	onAutoScrollChange,
	onTargetSelect,
	onDraftActiveChange,
	onSend,
}: TaskSessionChatComposerProps) {
	const {
		currentModel,
		currentModelInfo,
		availableModels,
		switching: modelSwitching,
		loading: modelLoading,
		switchModel,
	} = useModelSwitcher(sessionId);
	const [targetMenuOpen, setTargetMenuOpen] = useState(false);
	const selectedTarget = useMemo(
		() => targets.find((target) => target.id === selectedTargetId) ?? targets[0] ?? null,
		[targets, selectedTargetId]
	);
	const selectedTargetColor = selectedTarget ? getAgentColor(selectedTarget.label) : '#66A7FF';
	const selectedTargetInitial = selectedTarget ? agentInitial(selectedTarget.label) : 'A';

	// Return the boolean so MessageInput can restore the draft when sending fails
	const handleSend = async (
		content: string,
		_images?: MessageImage[],
		_deliveryMode?: MessageDeliveryMode
	): Promise<boolean> => {
		return onSend(content, selectedTarget);
	};

	const targetPicker =
		targets.length > 0 ? (
			<div class="relative">
				<button
					type="button"
					class="group inline-flex h-9 w-9 items-center justify-center rounded-full border border-dark-900/30 text-sm font-bold text-dark-950 shadow-sm ring-1 ring-white/10 transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-400/70 active:scale-95"
					style={{ backgroundColor: selectedTargetColor }}
					onClick={() => setTargetMenuOpen((open) => !open)}
					data-testid="task-composer-target-trigger"
					aria-label="Select message recipient"
					aria-haspopup="menu"
					aria-expanded={targetMenuOpen}
					title={selectedTarget ? `Send to ${selectedTarget.label}` : 'Select recipient'}
				>
					<span>{selectedTargetInitial}</span>
				</button>
				{targetMenuOpen && (
					<div
						class="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-lg border border-dark-700 bg-dark-850 shadow-xl shadow-black/30"
						data-testid="task-composer-target-menu"
					>
						<div class="border-b border-dark-700 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
							Send Message To
						</div>
						<div class="max-h-72 overflow-y-auto py-1">
							{targets.map((target) => (
								<button
									key={target.id}
									type="button"
									class={cn(
										'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-dark-700/70',
										target.id === selectedTarget?.id && 'bg-blue-500/15 text-blue-100'
									)}
									onClick={() => {
										onTargetSelect(target.id);
										setTargetMenuOpen(false);
									}}
									data-testid="task-composer-target-option"
								>
									<span class="min-w-0">
										<span class="block truncate text-gray-100">{target.label}</span>
										<span class="block truncate text-xs text-gray-500">
											{target.kind === 'task_agent'
												? 'Fallback coordinator'
												: `${target.nodeName ?? 'Workflow'}${target.state ? ` · ${target.state}` : ''}`}
										</span>
									</span>
									{target.id === selectedTarget?.id && (
										<span class="text-xs font-medium text-blue-300">Selected</span>
									)}
								</button>
							))}
						</div>
					</div>
				)}
			</div>
		) : null;

	return (
		<div class="relative z-10" data-testid="task-session-chat-composer">
			<ChatComposer
				sessionId={sessionId}
				readonly={false}
				isProcessing={isProcessing}
				features={{
					coordinator: false,
					worktree: false,
					rewind: false,
					archive: false,
					sessionInfo: false,
				}}
				currentModel={currentModel}
				currentModelInfo={currentModelInfo}
				availableModels={availableModels}
				modelSwitching={modelSwitching}
				modelLoading={modelLoading}
				autoScroll={autoScroll}
				coordinatorMode={false}
				coordinatorSwitching={false}
				sandboxEnabled={false}
				sandboxSwitching={false}
				isWaitingForInput={!canSend || isSending}
				isConnected={true}
				rewindMode={false}
				onModelSwitch={switchModel}
				onAutoScrollChange={onAutoScrollChange}
				onCoordinatorModeChange={() => {}}
				onSandboxModeChange={() => {}}
				onSend={handleSend}
				onOpenTools={() => {}}
				onEnterRewindMode={() => {}}
				onExitRewindMode={() => {}}
				agentMentionCandidates={mentionCandidates}
				inputPlaceholder={
					selectedTarget?.kind === 'task_agent'
						? hasTaskAgentSession
							? 'Message task agent...'
							: 'Message task agent (auto-start)...'
						: selectedTarget
							? `Message ${selectedTarget.label}...`
							: hasTaskAgentSession
								? 'Message task agent...'
								: 'Message task agent (auto-start)...'
				}
				inputLeadingElement={targetPicker}
				inputLeadingPaddingClass="pl-12"
				onDraftActiveChange={onDraftActiveChange}
				errorMessage={errorMessage}
			/>
		</div>
	);
}
