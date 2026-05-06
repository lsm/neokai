import type { ModelInfo, SpaceTaskActivityMember, ThinkingLevel } from '@neokai/shared';
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { toast } from '../lib/toast.ts';
import { useModelSwitcher } from './useModelSwitcher.ts';

export interface TaskComposerTarget {
	id: string;
	kind: 'task_agent' | 'node_agent';
	label: string;
	agentName?: string;
	nodeExecutionId?: string;
	nodeName?: string;
	state?: string;
}

export interface UseTargetSessionContextResult {
	/** Resolved session ID for the targeted agent, or null if not started */
	targetSessionId: string | null;
	/** Current model ID (live or pre-configured) */
	currentModel: string;
	/** Current model info (live or pre-configured) */
	currentModelInfo: ModelInfo | null;
	/** All available models from the server */
	availableModels: ModelInfo[];
	/** Whether a model switch is in progress */
	modelSwitching: boolean;
	/** Whether models are being loaded */
	modelLoading: boolean;
	/** Current thinking level (live or pre-configured) */
	thinkingLevel: ThinkingLevel;
	/** Whether the targeted agent is actively processing */
	isProcessing: boolean;
	/** Whether the targeted agent has a live session */
	isStarted: boolean;
	/** Switch model on the targeted session (or pre-configure) */
	switchModel: (model: ModelInfo) => Promise<void>;
	/** Set thinking level on the targeted session (or pre-configure) */
	setThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

/**
 * Resolve a composer target to its backing session ID.
 */
export function resolveTargetSessionId(
	target: TaskComposerTarget | null,
	activityMembers: SpaceTaskActivityMember[],
	taskAgentSessionId: string | null
): string | null {
	if (!target) return null;
	if (target.kind === 'task_agent') return taskAgentSessionId;

	// node_agent: prefer exact nodeExecutionId match, then fall back to agent name
	const member = activityMembers.find((m) => {
		if (m.kind !== 'node_agent') return false;
		if (target.nodeExecutionId) {
			return m.nodeExecution?.nodeExecutionId === target.nodeExecutionId;
		}
		return m.role === target.agentName || m.nodeExecution?.agentName === target.agentName;
	});
	return member?.sessionId ?? null;
}

/**
 * Hook that resolves the selected task-composer target to a live session
 * context (model, thinking, processing state) and supports pre-configuration
 * for agents that haven't started yet.
 */
export function useTargetSessionContext({
	taskId,
	targets,
	selectedTarget,
	activityMembers,
	taskAgentSessionId,
	defaultAgentModels,
}: {
	taskId: string;
	targets: TaskComposerTarget[];
	selectedTarget: TaskComposerTarget | null;
	activityMembers: SpaceTaskActivityMember[];
	taskAgentSessionId: string | null;
	defaultAgentModels?: Map<string, string>;
}): UseTargetSessionContextResult {
	const targetSessionId = useMemo(
		() => resolveTargetSessionId(selectedTarget, activityMembers, taskAgentSessionId),
		[selectedTarget, activityMembers, taskAgentSessionId]
	);
	const isStarted = !!targetSessionId;

	// Use the shared model switcher for the target session.
	// When the agent hasn't started yet sessionId is null; useModelSwitcher
	// skips session.model.get but still loads the global catalogue.
	const modelSwitcher = useModelSwitcher(targetSessionId);

	// In-memory pre-configuration for not-yet-started agents.
	// Model preconfig stores both id and provider so that auto-apply can
	// disambiguate when multiple providers expose the same model ID.
	const [preConfiguredModel, setPreConfiguredModel] = useState<
		Map<string, { id: string; provider: string }>
	>(new Map());
	const [preConfiguredThinking, setPreConfiguredThinking] = useState<Map<string, ThinkingLevel>>(
		new Map()
	);

	// Track which targets we've already auto-applied so we don't loop.
	const appliedAutoConfigRef = useRef<Set<string>>(new Set());

	// Reset pre-configuration state when the active task changes so stale
	// settings from a previous task don't leak into the new one.
	useEffect(() => {
		setPreConfiguredModel(new Map());
		setPreConfiguredThinking(new Map());
		appliedAutoConfigRef.current = new Set();
	}, [taskId]);

	// Default model from workflow definition (keyed by target ID).
	const defaultModel = useMemo(() => {
		if (!selectedTarget || selectedTarget.kind !== 'node_agent') {
			return '';
		}
		return defaultAgentModels?.get(selectedTarget.id) ?? '';
	}, [selectedTarget, defaultAgentModels]);

	// Effective model: live when started, pre-configured/default when not.
	const preConfigEntry = preConfiguredModel.get(selectedTarget?.id ?? '');
	const effectiveCurrentModel = isStarted
		? modelSwitcher.currentModel
		: (preConfigEntry?.id ?? defaultModel);

	const effectiveCurrentModelInfo = isStarted
		? modelSwitcher.currentModelInfo
		: (modelSwitcher.availableModels.find(
				(m) => m.id === effectiveCurrentModel && m.provider === preConfigEntry?.provider
			) ??
			modelSwitcher.availableModels.find((m) => m.id === effectiveCurrentModel) ??
			null);

	// Thinking level — default to auto.
	const [thinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>('auto');

	// Load the live thinking level from the session whenever the target
	// session changes (e.g. switching to a different started agent).
	useEffect(() => {
		if (!targetSessionId) return;
		let cancelled = false;
		const loadThinkingLevel = async () => {
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) return;
				const result = (await hub.request('session.thinking.get', {
					sessionId: targetSessionId,
				})) as { thinkingLevel: ThinkingLevel };
				if (!cancelled) {
					setLocalThinkingLevel(result.thinkingLevel);
				}
			} catch {
				// Ignore errors — keep current thinking level
			}
		};
		loadThinkingLevel();
		return () => {
			cancelled = true;
		};
	}, [targetSessionId]);

	// For unstarted targets, sync with pre-configured value.
	useEffect(() => {
		if (!selectedTarget || isStarted) return;
		setLocalThinkingLevel(preConfiguredThinking.get(selectedTarget.id) ?? 'auto');
	}, [selectedTarget?.id, isStarted, preConfiguredThinking]);

	// Destructure stable primitives from modelSwitcher to avoid effect re-runs
	// caused by the switcher object identity changing every render.
	const { availableModels: switcherModels } = modelSwitcher;

	// Auto-apply pre-configured settings when any target's session spawns.
	// Iterates over ALL targets so that background spawns (targets not currently
	// selected) still receive their pending preconfiguration.
	// Only marks a target as applied when at least one RPC was actually
	// attempted and all attempts succeeded; if preconditions are missing
	// (e.g. model info not yet loaded or hub disconnected) the target stays
	// unmarked and the effect retries on the next render cycle.
	useEffect(() => {
		for (const target of targets) {
			const targetId = target.id;
			if (appliedAutoConfigRef.current.has(targetId)) continue;

			const preModel = preConfiguredModel.get(targetId);
			const preThinking = preConfiguredThinking.get(targetId);
			if (!preModel && !preThinking) continue;

			const sessionId = resolveTargetSessionId(target, activityMembers, taskAgentSessionId);
			if (!sessionId) continue;

			let attempted = false;
			const promises: Promise<unknown>[] = [];

			// Apply model switch
			if (preModel) {
				const modelInfo = switcherModels.find(
					(m) => m.id === preModel.id && m.provider === preModel.provider
				);
				if (modelInfo) {
					attempted = true;
					const hub = connectionManager.getHubIfConnected();
					if (hub) {
						promises.push(
							hub.request('session.model.switch', {
								sessionId,
								model: modelInfo.id,
								provider: modelInfo.provider,
							})
						);
					} else {
						promises.push(Promise.reject(new Error('Not connected')));
					}
				}
			}

			// Apply thinking level
			if (preThinking) {
				const hub = connectionManager.getHubIfConnected();
				if (hub) {
					attempted = true;
					promises.push(
						hub.request('session.thinking.set', {
							sessionId,
							level: preThinking,
						})
					);
				}
			}

			if (!attempted) continue;

			Promise.all(promises)
				.then(() => {
					appliedAutoConfigRef.current.add(targetId);
					if (preThinking && target.id === selectedTarget?.id) {
						setLocalThinkingLevel(preThinking);
					}
				})
				.catch(() => {
					// Leave unmarked so the effect retries on next render
				});
		}
	}, [
		targets,
		activityMembers,
		taskAgentSessionId,
		preConfiguredModel,
		preConfiguredThinking,
		switcherModels,
	]);

	// Derive processing state from the activity member that owns this session.
	const isProcessing = useMemo(() => {
		if (!targetSessionId) return false;
		const member = activityMembers.find((m) => m.sessionId === targetSessionId);
		if (!member) return false;
		return member.processingStatus === 'processing' || member.processingStatus === 'queued';
	}, [targetSessionId, activityMembers]);

	const switchModel = useCallback(
		async (model: ModelInfo) => {
			if (!selectedTarget) return;
			if (!isStarted) {
				setPreConfiguredModel((prev) =>
					new Map(prev).set(selectedTarget.id, { id: model.id, provider: model.provider })
				);
				toast.success(`Pre-configured ${selectedTarget.label} to use ${model.name}`);
				return;
			}
			await modelSwitcher.switchModel(model);
		},
		[isStarted, selectedTarget, modelSwitcher]
	);

	const setThinkingLevel = useCallback(
		async (level: ThinkingLevel) => {
			setLocalThinkingLevel(level);
			if (!isStarted || !targetSessionId) {
				if (selectedTarget) {
					setPreConfiguredThinking((prev) => new Map(prev).set(selectedTarget.id, level));
				}
				return;
			}
			try {
				const hub = connectionManager.getHubIfConnected();
				if (!hub) {
					toast.error('Not connected to server');
					return;
				}
				await hub.request('session.thinking.set', {
					sessionId: targetSessionId,
					level,
				});
			} catch (err) {
				toast.error(err instanceof Error ? err.message : 'Failed to set thinking level');
			}
		},
		[isStarted, targetSessionId, selectedTarget]
	);

	return {
		targetSessionId,
		currentModel: effectiveCurrentModel,
		currentModelInfo: effectiveCurrentModelInfo,
		availableModels: modelSwitcher.availableModels,
		modelSwitching: modelSwitcher.switching,
		modelLoading: modelSwitcher.loading,
		thinkingLevel,
		isProcessing,
		isStarted,
		switchModel,
		setThinkingLevel,
	};
}
