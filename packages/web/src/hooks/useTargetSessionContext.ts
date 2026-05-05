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

	// node_agent: prefer activity member session, fall back to node execution
	const member = activityMembers.find(
		(m) =>
			m.kind === 'node_agent' &&
			(m.role === target.agentName || m.nodeExecution?.agentName === target.agentName)
	);
	return member?.sessionId ?? null;
}

/**
 * Hook that resolves the selected task-composer target to a live session
 * context (model, thinking, processing state) and supports pre-configuration
 * for agents that haven't started yet.
 */
export function useTargetSessionContext({
	selectedTarget,
	activityMembers,
	taskAgentSessionId,
	defaultAgentModels,
}: {
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
	// When the agent hasn't started yet the sessionId is a dummy value,
	// but models.list still loads the global catalogue.
	const modelSwitcher = useModelSwitcher(targetSessionId ?? '__not_started__');

	// In-memory pre-configuration for not-yet-started agents.
	const [preConfiguredModel, setPreConfiguredModel] = useState<Map<string, string>>(new Map());
	const [preConfiguredThinking, setPreConfiguredThinking] = useState<Map<string, ThinkingLevel>>(
		new Map()
	);

	// Track which targets we've already auto-applied so we don't loop.
	const appliedAutoConfigRef = useRef<Set<string>>(new Set());

	// Default model from workflow definition.
	const defaultModel = useMemo(() => {
		if (!selectedTarget || selectedTarget.kind !== 'node_agent' || !selectedTarget.agentName) {
			return '';
		}
		return defaultAgentModels?.get(selectedTarget.agentName) ?? '';
	}, [selectedTarget, defaultAgentModels]);

	// Effective model: live when started, pre-configured/default when not.
	const effectiveCurrentModel = isStarted
		? modelSwitcher.currentModel
		: (preConfiguredModel.get(selectedTarget?.id ?? '') ?? defaultModel);

	const effectiveCurrentModelInfo = isStarted
		? modelSwitcher.currentModelInfo
		: (modelSwitcher.availableModels.find((m) => m.id === effectiveCurrentModel) ?? null);

	// Thinking level — default to auto; sync with pre-configured value when switching targets.
	const [thinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel>('auto');

	useEffect(() => {
		if (!isStarted && selectedTarget) {
			setLocalThinkingLevel(preConfiguredThinking.get(selectedTarget.id) ?? 'auto');
		} else if (isStarted) {
			setLocalThinkingLevel('auto');
		}
	}, [selectedTarget?.id, isStarted, preConfiguredThinking]);

	// Auto-apply pre-configured settings when a session spawns.
	useEffect(() => {
		if (!targetSessionId || !selectedTarget) return;
		const targetId = selectedTarget.id;
		if (appliedAutoConfigRef.current.has(targetId)) return;

		const preModel = preConfiguredModel.get(targetId);
		const preThinking = preConfiguredThinking.get(targetId);
		if (!preModel && !preThinking) return;

		appliedAutoConfigRef.current.add(targetId);

		// Apply model switch
		if (preModel) {
			const modelInfo = modelSwitcher.availableModels.find((m) => m.id === preModel);
			if (modelInfo) {
				modelSwitcher.switchModel(modelInfo).catch(() => {
					// Best-effort; user can retry manually
				});
			}
		}

		// Apply thinking level
		if (preThinking) {
			connectionManager
				.getHubIfConnected()
				?.request('session.thinking.set', {
					sessionId: targetSessionId,
					level: preThinking,
				})
				.catch(() => {});
		}
	}, [targetSessionId, selectedTarget, preConfiguredModel, preConfiguredThinking, modelSwitcher]);

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
				setPreConfiguredModel((prev) => new Map(prev).set(selectedTarget.id, model.id));
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
