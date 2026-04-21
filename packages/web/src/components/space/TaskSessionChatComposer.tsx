import type { MessageDeliveryMode, MessageImage } from '@neokai/shared';
import { ChatComposer } from '../ChatComposer.tsx';
import { useModelSwitcher } from '../../hooks';

interface TaskSessionChatComposerProps {
	sessionId: string;
	mentionCandidates: Array<{ id: string; name: string }>;
	hasTaskAgentSession: boolean;
	canSend: boolean;
	isSending: boolean;
	errorMessage?: string | null;
	onSend: (message: string) => Promise<boolean>;
}

export function TaskSessionChatComposer({
	sessionId,
	mentionCandidates,
	hasTaskAgentSession,
	canSend,
	isSending,
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

	const handleSend = async (
		content: string,
		_images?: MessageImage[],
		_deliveryMode?: MessageDeliveryMode
	): Promise<void> => {
		await onSend(content);
	};

	return (
		<div data-testid="task-session-chat-composer">
			<ChatComposer
				sessionId={sessionId}
				readonly={false}
				isProcessing={false}
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
