/**
 * SpacesPage - Standalone spaces view with recent spaces and chat input
 *
 * Uses the pre-provisioned `spaces:global` session (Global Spaces Agent)
 * which is auto-created on daemon startup with space management MCP tools.
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
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { cn } from '../lib/utils.ts';
import MessageInput from '../components/MessageInput.tsx';
import SessionStatusBar from '../components/SessionStatusBar.tsx';

const GLOBAL_SESSION_ID = 'spaces:global';

export function SpacesPage() {
	const [autoScroll, setAutoScroll] = useState(true);
	const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
	const spaces = spaceStore.spaces.value;
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Select the pre-provisioned global spaces session on mount
	useEffect(() => {
		sessionStore.select(GLOBAL_SESSION_ID);
	}, []);

	// Initialize global space list on mount
	useEffect(() => {
		spaceStore.initGlobalList().catch(() => {
			// Error tracked inside initGlobalList
		});
	}, []);

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

	// Feature flags
	const features: SessionFeatures = session?.config?.features ?? DEFAULT_WORKER_FEATURES;

	// Model info
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

	const recentSpaces = spaces.slice(0, 5);

	const handleSpaceClick = async (spaceId: string) => {
		// Set the active space context on the daemon
		try {
			const hub = connectionManager.getHubIfConnected();
			if (hub) {
				await hub.request('spaces.global.setActiveSpace', { spaceId });
			}
		} catch {
			// Non-critical — agent will ask for space context
		}
		setActiveSpaceId(spaceId);
	};

	const handleSendMessage = useCallback(
		async (content: string, images?: MessageImage[], _deliveryMode?: MessageDeliveryMode) => {
			if (!content.trim()) return;

			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					toast.error('Connection lost');
					return;
				}
				await hub.request('session.message.send', {
					sessionId: GLOBAL_SESSION_ID,
					content,
					images,
				});
			} catch {
				toast.error('Failed to send message');
			}
		},
		[]
	);

	const isConnected = connectionState.value === 'connected';

	return (
		<div class="flex flex-col h-full bg-dark-900">
			{/* Main content area - takes up remaining space */}
			<div class="flex-1 overflow-y-auto">
				<div class="px-6 py-8">
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
										'hover:bg-dark-800/80',
										activeSpaceId === space.id && 'border-blue-500 bg-dark-800'
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
				</div>
			</div>

			{/* Message Composer - fixed at bottom */}
			<div
				class="border-t border-dark-800"
				style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
			>
				<div class="px-4 py-4 space-y-2">
					{/* Connection status */}
					{!isConnected && <div class="text-center text-sm text-amber-400">Connecting...</div>}

					{/* Session Status Bar */}
					<SessionStatusBar
						sessionId={GLOBAL_SESSION_ID}
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

					{/* Message Input */}
					<MessageInput
						sessionId={GLOBAL_SESSION_ID}
						onSend={handleSendMessage}
						disabled={!isConnected}
						autoScroll={autoScroll}
						onAutoScrollChange={setAutoScroll}
					/>
				</div>
			</div>

			<div ref={messagesEndRef} />
		</div>
	);
}
