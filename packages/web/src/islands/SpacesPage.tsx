/**
 * SpacesPage - Standalone spaces view with recent spaces and chat input
 *
 * Minimalist layout: no sidebar, just recent spaces list + floating message composer at bottom.
 */

import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import type {
	MessageImage,
	MessageDeliveryMode,
	ModelInfo,
	SessionFeatures,
	ThinkingLevel,
} from '@neokai/shared';
import { DEFAULT_WORKER_FEATURES } from '@neokai/shared';
import { spaceStore } from '../lib/space-store.ts';
import { sessionStore } from '../lib/session-store.ts';
import { createSession } from '../lib/api-helpers.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { navigateToSpace } from '../lib/router.ts';
import { connectionState } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';
import MessageInput from '../components/MessageInput.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';

export function SpacesPage() {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const spaces = spaceStore.spaces.value;
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Initialize global space list on mount
	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

	// When sessionId changes, select the session in sessionStore to load its state
	useEffect(() => {
		if (sessionId) {
			sessionStore.select(sessionId);
		}
	}, [sessionId]);

	// Get session state from sessionStore
	const session = sessionStore.sessionInfo.value;
	const agentState = sessionStore.agentState.value;
	const contextInfo = sessionStore.contextInfo.value;
	const sdkMessages = sessionStore.sdkMessages.value;

	// Derive SessionStatusBar props from session state
	const isProcessing = agentState.status === 'processing' || agentState.status === 'queued';
	const currentAction =
		'currentAction' in agentState && typeof agentState.currentAction === 'string'
			? agentState.currentAction
			: undefined;
	const streamingPhase: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null =
		agentState.status === 'processing' && 'phase' in agentState ? (agentState.phase ?? null) : null;

	// Feature flags - use defaults for this simple page
	const features: SessionFeatures = session?.config?.features ?? DEFAULT_WORKER_FEATURES;

	// Model info - use defaults since we don't have full model picker setup
	const currentModel: string = session?.config?.model ?? 'claude-sonnet-4-20250514';
	const currentModelInfo: ModelInfo | null = null;
	const availableModels: ModelInfo[] = [];
	const modelSwitching = false;
	const modelLoading = false;
	const onModelSwitch = (_model: ModelInfo) => {};
	const coordinatorMode = false;
	const coordinatorSwitching = false;
	const onCoordinatorModeChange = (_enabled: boolean) => {};
	const sandboxEnabled = false;
	const sandboxSwitching = false;
	const onSandboxModeChange = (_enabled: boolean) => {};
	const thinkingLevel: ThinkingLevel | undefined = session?.config?.thinkingLevel;

	// Scroll to bottom when messages change
	useEffect(() => {
		if (autoScroll && messagesEndRef.current) {
			messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
		}
	}, [sdkMessages]);

	// For now, just show recent spaces - will be connected to a space agent later
	const recentSpaces = spaces.slice(0, 5);

	const handleSpaceClick = (spaceId: string) => {
		navigateToSpace(spaceId);
	};

	const handleSendMessage = useCallback(
		async (content: string, images?: MessageImage[], _deliveryMode?: MessageDeliveryMode) => {
			if (!content.trim()) return;

			// Create session on first message if needed
			let currentSessionId = sessionId;
			if (!currentSessionId) {
				try {
					const response = await createSession({
						workspacePath: undefined,
						createdBy: 'human',
					});
					currentSessionId = response.sessionId;
					setSessionId(currentSessionId);
				} catch {
					toast.error('Failed to create session');
					return;
				}
			}

			// Send the message
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					toast.error('Connection lost');
					return;
				}
				await hub.request('session.message.send', {
					sessionId: currentSessionId,
					content,
					images,
				});
			} catch {
				toast.error('Failed to send message');
			}
		},
		[sessionId]
	);

	const isConnected = connectionState.value === 'connected';

	return (
		<div class="relative flex-1 flex flex-col h-full bg-dark-900">
			{/* Recent Spaces - scrollable top area */}
			<div class="flex-1 overflow-y-auto p-6">
				<h2 class="text-lg font-semibold text-gray-100 mb-4">Recent Spaces</h2>
				{recentSpaces.length === 0 ? (
					<div class="flex flex-col items-center justify-center p-8 text-center">
						<div class="text-4xl mb-3">🚀</div>
						<p class="text-gray-400 mb-1">No spaces yet</p>
						<p class="text-sm text-gray-500">Create a space to get started</p>
					</div>
				) : (
					<div class="grid gap-3">
						{recentSpaces.map((space) => (
							<button
								key={space.id}
								onClick={() => handleSpaceClick(space.id)}
								class={cn(
									'p-4 rounded-lg border text-left transition-colors',
									'bg-dark-800 border-dark-700 hover:border-dark-600',
									'hover:bg-dark-800/80'
								)}
							>
								<div class="flex items-center gap-3">
									<div class="w-10 h-10 rounded-lg bg-dark-700 flex items-center justify-center text-xl">
										🚀
									</div>
									<div class="flex-1 min-w-0">
										<h3 class="font-medium text-gray-100 truncate">{space.name}</h3>
										{space.description && (
											<p class="text-sm text-gray-400 truncate">{space.description}</p>
										)}
									</div>
								</div>
							</button>
						))}
					</div>
				)}

				{/* Spacer for floating composer */}
				<div class="h-48" />
			</div>

			{/* Floating Message Composer - positioned at bottom */}
			<div class="absolute bottom-0 left-0 right-0 z-10 pointer-events-none">
				<div
					class="pointer-events-auto pt-4 bg-gradient-to-t from-dark-900 from-[calc(100%-32px)] to-dark-900/0"
					style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
				>
					<div class="max-w-3xl mx-auto px-4 space-y-2">
						{/* Connection status */}
						{!isConnected && <div class="text-center text-sm text-amber-400">Connecting...</div>}

						{/* Session Status Bar */}
						{sessionId && (
							<SessionStatusBar
								sessionId={sessionId}
								isProcessing={isProcessing}
								currentAction={currentAction}
								streamingPhase={streamingPhase}
								contextUsage={contextInfo ?? undefined}
								maxContextTokens={200000}
								features={features}
								currentModel={currentModel}
								currentModelInfo={currentModelInfo}
								availableModels={availableModels}
								modelSwitching={modelSwitching}
								modelLoading={modelLoading}
								onModelSwitch={onModelSwitch}
								autoScroll={autoScroll}
								onAutoScrollChange={setAutoScroll}
								coordinatorMode={coordinatorMode}
								coordinatorSwitching={coordinatorSwitching}
								onCoordinatorModeChange={onCoordinatorModeChange}
								sandboxEnabled={sandboxEnabled}
								sandboxSwitching={sandboxSwitching}
								onSandboxModeChange={onSandboxModeChange}
								thinkingLevel={thinkingLevel}
							/>
						)}

						{/* Message Input */}
						{sessionId ? (
							<MessageInput
								sessionId={sessionId}
								onSend={handleSendMessage}
								disabled={!isConnected}
								autoScroll={autoScroll}
								onAutoScrollChange={setAutoScroll}
							/>
						) : (
							<div class="bg-dark-800 border border-dark-700 rounded-lg p-4 text-center text-gray-400">
								Type a message below to start chatting
							</div>
						)}
					</div>
				</div>
			</div>

			<div ref={messagesEndRef} />
		</div>
	);
}
