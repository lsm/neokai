import type { MessageDeliveryMode, MessageImage } from '@neokai/shared';
import { ChatComposer } from '../ChatComposer.tsx';
import { useModelSwitcher } from '../../hooks';

interface TaskSessionChatComposerProps {
	sessionId: string;
	mentionCandidates: Array<{ id: string; name: string }>;
	hasTaskAgentSession: boolean;
	canSend: boolean;
	isSending: boolean;
	isProcessing: boolean;
	errorMessage?: string | null;
	onSend: (message: string) => Promise<boolean>;
}

export function TaskSessionChatComposer({
	sessionId,
	mentionCandidates,
	hasTaskAgentSession,
	canSend,
	isSending,
	isProcessing,
	errorMessage,
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

	// Return the boolean so MessageInput can restore the draft when sending fails
	const handleSend = async (
		content: string,
		_images?: MessageImage[],
		_deliveryMode?: MessageDeliveryMode
	): Promise<boolean> => {
		return onSend(content);
	};

	return (
		<div class="relative z-10" data-testid="task-session-chat-composer">
			<div
				class="pointer-events-none absolute bottom-0 left-0 right-0 z-[9] h-24"
				data-testid="task-composer-readability-scrim"
				aria-hidden="true"
			>
				<div class="absolute inset-0 bg-gradient-to-t from-dark-900/90 via-dark-900/40 to-transparent" />
				<div class="absolute inset-0 backdrop-blur-[1px] [mask-image:linear-gradient(to_top,black_0%,black_55%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_top,black_0%,black_55%,transparent_100%)]" />
			</div>
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
				autoScroll={false}
				coordinatorMode={false}
				coordinatorSwitching={false}
				sandboxEnabled={false}
				sandboxSwitching={false}
				isWaitingForInput={!canSend || isSending}
				isConnected={true}
				rewindMode={false}
				onModelSwitch={switchModel}
				onAutoScrollChange={() => {}}
				onCoordinatorModeChange={() => {}}
				onSandboxModeChange={() => {}}
				onSend={handleSend}
				onOpenTools={() => {}}
				onEnterRewindMode={() => {}}
				onExitRewindMode={() => {}}
				agentMentionCandidates={mentionCandidates}
				inputPlaceholder={
					hasTaskAgentSession ? 'Message task agent...' : 'Message task agent (auto-start)...'
				}
				errorMessage={errorMessage}
			/>
		</div>
	);
}
