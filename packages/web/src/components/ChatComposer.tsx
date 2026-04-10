import type {
	ContextInfo,
	MessageDeliveryMode,
	MessageImage,
	ModelInfo,
	SessionFeatures,
	SessionType,
	ThinkingLevel,
} from '@neokai/shared';
import MessageInput from './MessageInput.tsx';
import SessionStatusBar from './SessionStatusBar.tsx';
import { borderColors } from '../lib/design-tokens.ts';
import { cn } from '../lib/utils.ts';

interface ChatComposerProps {
	sessionId: string;
	readonly: boolean;
	sessionStatus?: string;
	sessionType?: SessionType;
	thinkingLevel?: ThinkingLevel;
	isProcessing: boolean;
	currentAction?: string;
	streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
	contextUsage?: ContextInfo;
	features: SessionFeatures;
	currentModel: string;
	currentModelInfo: ModelInfo | null;
	availableModels: ModelInfo[];
	modelSwitching: boolean;
	modelLoading: boolean;
	autoScroll: boolean;
	coordinatorMode: boolean;
	coordinatorSwitching: boolean;
	sandboxEnabled: boolean;
	sandboxSwitching: boolean;
	isWaitingForInput: boolean;
	isConnected: boolean;
	rewindMode: boolean;
	onModelSwitch: (model: ModelInfo) => void;
	onAutoScrollChange: (enabled: boolean) => void;
	onCoordinatorModeChange: (enabled: boolean) => void;
	onSandboxModeChange: (enabled: boolean) => void;
	onSend: (
		content: string,
		images?: MessageImage[],
		deliveryMode?: MessageDeliveryMode
	) => Promise<void>;
	onOpenTools: () => void;
	onEnterRewindMode: () => void;
	onExitRewindMode: () => void;
}

export function ChatComposer({
	sessionId,
	readonly,
	sessionStatus,
	sessionType,
	thinkingLevel,
	isProcessing,
	currentAction,
	streamingPhase,
	contextUsage,
	features,
	currentModel,
	currentModelInfo,
	availableModels,
	modelSwitching,
	modelLoading,
	autoScroll,
	coordinatorMode,
	coordinatorSwitching,
	sandboxEnabled,
	sandboxSwitching,
	isWaitingForInput,
	isConnected,
	rewindMode,
	onModelSwitch,
	onAutoScrollChange,
	onCoordinatorModeChange,
	onSandboxModeChange,
	onSend,
	onOpenTools,
	onEnterRewindMode,
	onExitRewindMode,
}: ChatComposerProps) {
	return (
		<div class="chat-footer absolute bottom-0 left-0 right-0 z-10 pt-4 bg-gradient-to-t from-dark-900 from-[calc(100%-32px)] to-dark-900/0">
			<SessionStatusBar
				sessionId={sessionId}
				isProcessing={isProcessing}
				currentAction={currentAction}
				streamingPhase={streamingPhase}
				contextUsage={contextUsage}
				maxContextTokens={200000}
				features={features}
				currentModel={currentModel}
				currentModelInfo={currentModelInfo}
				availableModels={availableModels}
				modelSwitching={modelSwitching}
				modelLoading={modelLoading}
				onModelSwitch={onModelSwitch}
				autoScroll={autoScroll}
				onAutoScrollChange={onAutoScrollChange}
				coordinatorMode={coordinatorMode}
				coordinatorSwitching={coordinatorSwitching}
				onCoordinatorModeChange={onCoordinatorModeChange}
				sandboxEnabled={sandboxEnabled}
				sandboxSwitching={sandboxSwitching}
				onSandboxModeChange={onSandboxModeChange}
				thinkingLevel={thinkingLevel}
			/>

			{sessionStatus === 'archived' ? (
				<div class="p-4">
					<div class="max-w-4xl mx-auto">
						<div
							class={cn(
								'rounded-3xl border px-5 py-3 text-center',
								'bg-dark-800/60 backdrop-blur-sm',
								borderColors.ui.default
							)}
						>
							<span class="text-gray-400 text-sm flex items-center justify-center gap-2">
								<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
								Session archived
							</span>
						</div>
					</div>
				</div>
			) : (
				!readonly && (
					<MessageInput
						sessionId={sessionId}
						sessionType={sessionType}
						onSend={onSend}
						disabled={isWaitingForInput || !isConnected}
						autoScroll={autoScroll}
						onAutoScrollChange={onAutoScrollChange}
						onOpenTools={onOpenTools}
						onEnterRewindMode={onEnterRewindMode}
						rewindMode={rewindMode}
						onExitRewindMode={onExitRewindMode}
					/>
				)
			)}
		</div>
	);
}
