/**
 * VisualWorkflowEditor
 *
 * Top-level orchestrator for the visual workflow editor. Composes the canvas,
 * nodes, edges, config panels and toolbar into a complete editing experience.
 *
 * Handles:
 *  - Loading an existing workflow into visual state (positions from layout field,
 *    falling back to autoLayout when absent)
 *  - Adding / removing / dragging nodes
 *  - Creating / deleting edges via port drag or keyboard
 *  - Editing step properties via NodeConfigPanel
 *  - Editing edge conditions via EdgeConfigPanel
 *  - Designating the start node
 *  - Persisting layout positions on save
 *  - Tags and WorkflowRulesEditor (collapsible)
 *
 * NOTE: This component is designed for mount-only initialisation. If `workflow`
 * changes after mount, the component will NOT re-initialise — callers should
 * provide a stable `key` prop to force remount when switching between workflows.
 */

import { useState, useMemo, useCallback, useRef } from 'preact/hooks';
import type {
	SpaceWorkflow,
	WorkflowNode,
	WorkflowConditionType,
	WorkflowChannel,
} from '@neokai/shared';
import { generateUUID, TASK_AGENT_NODE_ID } from '@neokai/shared';
import { spaceStore } from '../../../lib/space-store';
import { filterAgents, TEMPLATES } from '../WorkflowEditor';
import type { WorkflowTemplate } from '../WorkflowEditor';
import { WorkflowRulesEditor } from '../WorkflowRulesEditor';
import type { RuleDraft } from '../WorkflowRulesEditor';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import type { ConditionDraft } from './GateConfig';
import type { ViewportState, Point, VisualTransition } from './types';
import type { VisualNode, VisualEdge, VisualEditorState } from './serialization';
import {
	workflowToVisualState,
	visualStateToCreateParams,
	visualStateToUpdateParams,
} from './serialization';
import type { WorkflowNodeData } from './WorkflowCanvas';
import { WorkflowCanvas, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from './WorkflowCanvas';
import { computeFitToView } from './CanvasToolbar';
import { autoLayout, TASK_AGENT_INITIAL_POSITION } from './layout';
import type { NodePosition } from './types';
import { NodeConfigPanel } from './NodeConfigPanel';
import { ChannelEditor } from '../ChannelEditor';
import { EdgeConfigPanel } from './EdgeConfigPanel';

// ============================================================================
// Constants
// ============================================================================

const TAG_SUGGESTIONS = ['coding', 'review', 'research', 'design', 'deployment'];

// ============================================================================
// Props
// ============================================================================

export interface VisualWorkflowEditorProps {
	/** Existing workflow to edit. Undefined means create new. */
	workflow?: SpaceWorkflow;
	onSave: () => void;
	onCancel: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function VisualWorkflowEditor({ workflow, onSave, onCancel }: VisualWorkflowEditorProps) {
	const isEditing = !!workflow;

	// ------------------------------------------------------------------
	// Initialize from existing workflow (on mount only).
	// See file-level NOTE: callers must key this component to force remount
	// when switching between workflows.
	// ------------------------------------------------------------------
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const initState: VisualEditorState | null = useMemo(
		() => (workflow ? workflowToVisualState(workflow) : null),
		[]
	);

	// ------------------------------------------------------------------
	// State
	// ------------------------------------------------------------------

	const [name, setName] = useState(workflow?.name ?? '');
	const [description, setDescription] = useState(workflow?.description ?? '');
	const [nodes, setNodes] = useState<VisualNode[]>(() => {
		if (initState) return initState.nodes;
		// Create mode: inject the Task Agent virtual node immediately so it is
		// always present, even before any real step is added.
		// Use the exported layout constant so this position stays in sync with autoLayout.
		return [
			{
				step: {
					localId: TASK_AGENT_NODE_ID,
					id: TASK_AGENT_NODE_ID,
					name: 'Task Agent',
					agentId: '',
					instructions: '',
				},
				position: TASK_AGENT_INITIAL_POSITION,
			},
		];
	});
	const [edges, setEdges] = useState<VisualEdge[]>(() => initState?.edges ?? []);
	const [rules, setRules] = useState<RuleDraft[]>(() => initState?.rules ?? []);
	const [tags, setTags] = useState<string[]>(() => initState?.tags ?? []);
	const [startNodeId, setStartStepId] = useState<string>(() => initState?.startNodeId ?? '');
	const [channels, setChannels] = useState<WorkflowChannel[]>(() => initState?.channels ?? []);
	// Guard against double-invocation: setNodes updater may be called twice in development
	// (e.g. React StrictMode, Bun hot reload). Toggle the flag so the second call skips.
	const addStepGuardRef = useRef(false);
	const [viewportState, setViewportState] = useState<ViewportState>({
		offsetX: 0,
		offsetY: 0,
		scale: 1,
	});

	// Selection state — lifted so config panels can render from the editor
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); // step.localId
	// Edge IDs have the format "fromLocalId:toLocalId". This is safe because
	// crypto.randomUUID() produces hyphenated hex strings that never contain
	// colons, so the first ':' unambiguously splits from/to.
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
	const [showChannels, setShowChannels] = useState(true);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRules, setShowRules] = useState(false);
	const [showTemplates, setShowTemplates] = useState(false);
	const [tagInput, setTagInput] = useState('');

	const canvasContainerRef = useRef<HTMLDivElement>(null);

	const agents = filterAgents(spaceStore.agents.value);
	const tasksByNodeId = spaceStore.tasksByNodeId.value;

	// Determine which workflow run to use for completion indicators.
	// Prefer an active run; fall back to the most recently updated run.
	const relevantRunId = (() => {
		if (!workflow?.id) return null;
		const runs = spaceStore.workflowRuns.value.filter((r) => r.workflowId === workflow.id);
		if (!runs.length) return null;
		const active = runs.find((r) => r.status === 'pending' || r.status === 'in_progress');
		if (active) return active.id;
		return [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
	})();

	// Collect all agent slot names from nodes for ChannelEditor from/to suggestions
	const agentRoles = useMemo(() => {
		const roles = new Set<string>();
		for (const node of nodes) {
			if (node.step.id === TASK_AGENT_NODE_ID || node.step.localId === TASK_AGENT_NODE_ID) continue;
			if (node.step.agents) {
				for (const agent of node.step.agents) {
					if (agent.name) roles.add(agent.name);
				}
			}
		}
		return Array.from(roles);
	}, [nodes]);

	// ------------------------------------------------------------------
	// Key-resolution maps
	// ------------------------------------------------------------------

	/** Maps step.localId -> step key used in VisualEdge (step.id ?? step.localId). */
	const localIdToStepKey = useMemo(() => {
		const map = new Map<string, string>();
		for (const node of nodes) {
			map.set(node.step.localId, node.step.id ?? node.step.localId);
		}
		return map;
	}, [nodes]);

	// ------------------------------------------------------------------
	// Derived: ResolvedWorkflowChannel[] for workflow-level channel connections.
	// Resolves channel from/to agent role names to node localIds so EdgeRenderer
	// can render the edges. Includes gate type and ID for visual distinction + selection.
	// ------------------------------------------------------------------

	const channelEdges = useMemo<
		{
			fromStepId: string;
			toStepId: string;
			direction: 'one-way' | 'bidirectional';
			gateType?: 'human' | 'condition' | 'task_result';
			id?: string;
			label?: string;
		}[]
	>(() => {
		const result: {
			fromStepId: string;
			toStepId: string;
			direction: 'one-way' | 'bidirectional';
			gateType?: 'human' | 'condition' | 'task_result';
			id?: string;
			label?: string;
		}[] = [];

		// Build agent name -> node localId lookup for cross-node channel resolution
		const nameToNodeId = new Map<string, string>();
		for (const node of nodes) {
			if (node.step.id === TASK_AGENT_NODE_ID || node.step.localId === TASK_AGENT_NODE_ID) continue;
			// Map agent slot names (from WorkflowNodeAgent.name)
			if (node.step.agents) {
				for (const agent of node.step.agents) {
					if (agent.name) nameToNodeId.set(agent.name, node.step.localId);
				}
			}
			// Also map node name itself for convenience
			if (node.step.name) nameToNodeId.set(node.step.name, node.step.localId);
		}

		const nodeLocalIds = new Set(nodes.map((n) => n.step.localId));

		channels.forEach((channel, i) => {
			const channelId = String(i);
			const gateType =
				channel.gate && channel.gate.type !== 'always'
					? (channel.gate.type as 'human' | 'condition' | 'task_result')
					: undefined;

			if (channel.from === 'task-agent') {
				// task-agent -> node channel: resolve 'to' to a node localId
				const toTargets = Array.isArray(channel.to) ? channel.to : [channel.to];
				for (const toStr of toTargets) {
					const targetNode = nodes.find(
						(n) =>
							n.step.localId === toStr ||
							n.step.id === toStr ||
							nameToNodeId.get(toStr) === n.step.localId
					);
					if (targetNode) {
						result.push({
							fromStepId: 'task-agent',
							toStepId: targetNode.step.localId,
							direction: channel.direction,
							gateType,
							id: channelId,
							label: channel.label,
						});
					}
				}
			} else {
				// Cross-node channel: resolve from agent name to node localId
				const fromNodeId =
					nameToNodeId.get(channel.from) ?? (nodeLocalIds.has(channel.from) ? channel.from : null);
				if (!fromNodeId) return;

				const toTargets = Array.isArray(channel.to) ? channel.to : [channel.to];
				for (const toStr of toTargets) {
					if (toStr === '*') continue; // wildcard: no specific edge to render
					const toNodeId = nameToNodeId.get(toStr) ?? (nodeLocalIds.has(toStr) ? toStr : null);
					if (!toNodeId || toNodeId === fromNodeId) continue;
					result.push({
						fromStepId: fromNodeId,
						toStepId: toNodeId,
						direction: channel.direction,
						gateType,
						id: channelId,
						label: channel.label,
					});
				}
			}
		});

		return result;
	}, [channels, nodes]);

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/** True when the given node is the current start node. */
	const nodeIsStart = useCallback(
		(node: VisualNode): boolean => {
			return node.step.localId === startNodeId || node.step.id === startNodeId;
		},
		[startNodeId]
	);

	/** Find the first incoming edge condition for a node (entry gate). */
	function getEntryCondition(node: VisualNode): ConditionDraft | null {
		const key = node.step.id ?? node.step.localId;
		const incoming = edges.find((e) => e.toStepKey === key);
		if (!incoming) return null;
		const cond = incoming.condition;
		if (!cond || cond.type === 'always') return { type: 'always' };
		return { type: cond.type, expression: cond.expression };
	}

	/** Find the first outgoing edge condition for a node (exit gate). */
	function getExitCondition(node: VisualNode): ConditionDraft | null {
		const key = node.step.id ?? node.step.localId;
		const outgoing = edges.find((e) => e.fromStepKey === key);
		if (!outgoing) return null;
		const cond = outgoing.condition;
		if (!cond || cond.type === 'always') return { type: 'always' };
		return { type: cond.type, expression: cond.expression };
	}

	// ------------------------------------------------------------------
	// Derived: WorkflowNodeData[] for WorkflowCanvas
	// ------------------------------------------------------------------

	const nodeData = useMemo<WorkflowNodeData[]>(() => {
		return nodes.map((node, i) => {
			const nodeId = node.step.id;
			const allNodeTasks = nodeId ? (tasksByNodeId.get(nodeId) ?? []) : [];
			// Filter to the most relevant run to avoid mixing state from past runs.
			const nodeTasks = relevantRunId
				? allNodeTasks.filter((t) => t.workflowRunId === relevantRunId)
				: allNodeTasks;
			const nodeTaskStates: AgentTaskState[] = nodeTasks.map((t) => ({
				agentName: t.agentName ?? null,
				status: t.status,
				completionSummary: t.completionSummary,
			}));
			return {
				stepIndex: i,
				step: node.step,
				position: node.position,
				agents,
				workflowChannels: channels,
				isStartNode: nodeIsStart(node),
				nodeTaskStates: nodeTaskStates.length > 0 ? nodeTaskStates : undefined,
			};
		});
	}, [nodes, agents, channels, nodeIsStart, tasksByNodeId, relevantRunId]);

	// ------------------------------------------------------------------
	// Derived: selected node / edge
	// ------------------------------------------------------------------

	const selectedNode = selectedNodeId
		? (nodes.find((n) => n.step.localId === selectedNodeId) ?? null)
		: null;

	const selectedEdgeInfo = useMemo(() => {
		if (!selectedEdgeId) return null;
		const colonIdx = selectedEdgeId.indexOf(':');
		if (colonIdx === -1) return null;
		const fromLocalId = selectedEdgeId.slice(0, colonIdx);
		const toLocalId = selectedEdgeId.slice(colonIdx + 1);
		const fromNode = nodes.find((n) => n.step.localId === fromLocalId);
		const toNode = nodes.find((n) => n.step.localId === toLocalId);
		if (!fromNode || !toNode) return null;
		const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
		const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
		const edge = edges.find((e) => e.fromStepKey === fromKey && e.toStepKey === toKey);
		return { fromNode, toNode, edge, fromKey, toKey };
	}, [selectedEdgeId, nodes, edges, localIdToStepKey]);

	// ------------------------------------------------------------------
	// Node operations
	// ------------------------------------------------------------------

	function addStep() {
		// Guard: skip if already called this cycle (e.g. double-invoked by React/StictMode).
		if (addStepGuardRef.current) return;
		addStepGuardRef.current = true;
		// Reset on next paint so the guard is fresh for the next click.
		void Promise.resolve().then(() => {
			addStepGuardRef.current = false;
		});

		const newLocalId = generateUUID();
		const newStep: NodeDraft = { localId: newLocalId, name: '', agentId: '', instructions: '' };

		setNodes((prev) => {
			// Exclude the Task Agent virtual node — it is always present but not a real workflow step.
			const isFirstNode =
				prev.filter(
					(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
				).length === 0;
			if (isFirstNode) setStartStepId(newLocalId);

			// Stagger new nodes vertically so they don't overlap (nodes are ~160×80px).
			// Count only regular nodes so the Task Agent's fixed slot doesn't offset the stagger.
			const regularCount = prev.filter(
				(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
			).length;
			const position: Point = { x: 120, y: 80 + regularCount * 100 };
			return [...prev, { step: newStep, position }];
		});
	}

	const handleNodePositionChange = useCallback((localId: string, newPosition: Point) => {
		// Task Agent is pinned — its position must never change.
		if (localId === TASK_AGENT_NODE_ID) return;
		setNodes((prev) =>
			prev.map((n) => (n.step.localId === localId ? { ...n, position: newPosition } : n))
		);
	}, []);

	const handleNodeSelect = useCallback((localId: string | null) => {
		// Task Agent is a virtual node — it must not be selectable so neither the
		// NodeConfigPanel (which would show a delete button) nor the keyboard Delete
		// handler (which fires on the WorkflowCanvas selected node) can remove it.
		if (localId === TASK_AGENT_NODE_ID) return;
		setSelectedNodeId(localId);
		if (localId) setSelectedEdgeId(null);
	}, []);

	const handleDeleteNode = useCallback(
		(localId: string) => {
			// Task Agent is a virtual node that must always be present — defend against
			// both the NodeConfigPanel delete path and the keyboard Delete path.
			if (localId === TASK_AGENT_NODE_ID) return;

			// Read current state from closure (nodes + startNodeId are deps).
			const nodeToDelete = nodes.find((n) => n.step.localId === localId);
			if (!nodeToDelete) return;

			const key = nodeToDelete.step.id ?? nodeToDelete.step.localId;
			const remaining = nodes.filter((n) => n.step.localId !== localId);
			const wasStart =
				nodeToDelete.step.localId === startNodeId || nodeToDelete.step.id === startNodeId;

			// Update all state in flat calls — no nested setter inside another updater.
			setNodes(remaining);
			setEdges((prev) => prev.filter((e) => e.fromStepKey !== key && e.toStepKey !== key));

			// Pick the next start node from regular (non-virtual) nodes only.
			// Task Agent is always at remaining[0] so using it as the next start would
			// show the START badge on the virtual node, which is visually wrong.
			const regularRemaining = remaining.filter(
				(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
			);
			if (wasStart && regularRemaining.length > 0) {
				const next = regularRemaining[0];
				setStartStepId(next.step.id ?? next.step.localId);
			} else if (wasStart) {
				setStartStepId('');
			}

			setSelectedNodeId(null);
		},
		[nodes, startNodeId]
	);

	const handleUpdateNode = useCallback((step: NodeDraft) => {
		setNodes((prev) => prev.map((n) => (n.step.localId === step.localId ? { ...n, step } : n)));
	}, []);

	/**
	 * Set this node as the start node. Stores step.localId so that both the
	 * nodeIsStart helper and the serializer can resolve it (the serializer checks
	 * both localIdMap and nodeMap, so localId always works regardless of whether
	 * the step has a persisted step.id).
	 */
	const handleSetAsStart = useCallback((localId: string) => {
		setStartStepId(localId);
	}, []);

	const handleUpdateEntryCondition = useCallback((node: VisualNode, cond: ConditionDraft) => {
		const key = node.step.id ?? node.step.localId;
		let updated = false;
		setEdges((prev) =>
			prev.map((e) => {
				if (e.toStepKey !== key || updated) return e;
				updated = true;
				const newCond =
					cond.type === 'always'
						? undefined
						: { ...e.condition, type: cond.type, expression: cond.expression };
				return { ...e, condition: newCond };
			})
		);
	}, []);

	const handleUpdateExitCondition = useCallback((node: VisualNode, cond: ConditionDraft) => {
		const key = node.step.id ?? node.step.localId;
		let updated = false;
		setEdges((prev) =>
			prev.map((e) => {
				if (e.fromStepKey !== key || updated) return e;
				updated = true;
				const newCond =
					cond.type === 'always'
						? undefined
						: { ...e.condition, type: cond.type, expression: cond.expression };
				return { ...e, condition: newCond };
			})
		);
	}, []);

	// ------------------------------------------------------------------
	// Edge operations
	// ------------------------------------------------------------------

	const handleEdgeSelect = useCallback((edgeId: string | null) => {
		setSelectedEdgeId(edgeId);
		if (edgeId) {
			setSelectedNodeId(null);
			setSelectedChannelId(null);
		}
	}, []);

	const handleChannelSelect = useCallback((channelId: string | null) => {
		setSelectedChannelId(channelId);
		if (channelId) {
			setSelectedNodeId(null);
			setSelectedEdgeId(null);
			// Auto-expand the Channels section when a channel is selected via canvas
			setShowChannels(true);
		}
	}, []);

	const handleCreateTransition = useCallback(
		(fromLocalId: string, toLocalId: string) => {
			// Task Agent is not a step in the execution flow — prevent it from being
			// a source or target of workflow transitions.
			if (fromLocalId === TASK_AGENT_NODE_ID || toLocalId === TASK_AGENT_NODE_ID) return;

			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) => {
				if (prev.some((e) => e.fromStepKey === fromKey && e.toStepKey === toKey)) return prev;
				return [...prev, { fromStepKey: fromKey, toStepKey: toKey, condition: undefined }];
			});
		},
		[localIdToStepKey]
	);

	const handleDeleteEdge = useCallback(
		(edgeId: string) => {
			const colonIdx = edgeId.indexOf(':');
			if (colonIdx === -1) return;
			const fromLocalId = edgeId.slice(0, colonIdx);
			const toLocalId = edgeId.slice(colonIdx + 1);
			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) => prev.filter((e) => !(e.fromStepKey === fromKey && e.toStepKey === toKey)));
			setSelectedEdgeId(null);
		},
		[localIdToStepKey]
	);

	const handleUpdateEdgeCondition = useCallback(
		(edgeId: string, conditionType: WorkflowConditionType, expression?: string) => {
			const colonIdx = edgeId.indexOf(':');
			if (colonIdx === -1) return;
			const fromLocalId = edgeId.slice(0, colonIdx);
			const toLocalId = edgeId.slice(colonIdx + 1);
			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) =>
				prev.map((e) => {
					if (e.fromStepKey !== fromKey || e.toStepKey !== toKey) return e;
					const newCond =
						conditionType === 'always'
							? undefined
							: { ...e.condition, type: conditionType, expression };
					return { ...e, condition: newCond };
				})
			);
		},
		[localIdToStepKey]
	);

	// ------------------------------------------------------------------
	// Tags
	// ------------------------------------------------------------------

	function addTag(value: string) {
		const trimmed = value.trim().toLowerCase();
		if (trimmed && !tags.includes(trimmed)) {
			setTags((prev) => [...prev, trimmed]);
		}
	}

	function removeTag(tag: string) {
		setTags((prev) => prev.filter((t) => t !== tag));
	}

	function handleTagInputKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag(tagInput);
			setTagInput('');
		} else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
			removeTag(tags[tags.length - 1]);
		}
	}

	// ------------------------------------------------------------------
	// Template
	// ------------------------------------------------------------------

	function applyTemplate(template: WorkflowTemplate) {
		const localIds = template.stepRoles.map(() => generateUUID());
		const firstLocalId = localIds[0];

		const newNodes: VisualNode[] = template.stepRoles.map((role, i) => {
			const found = agents.find(
				(a) => a.name.toLowerCase() === role || a.role.toLowerCase() === role
			);
			return {
				step: {
					localId: localIds[i],
					name: role.charAt(0).toUpperCase() + role.slice(1),
					agentId: found?.id ?? '',
					instructions: '',
				},
				position: { x: 0, y: 0 }, // overwritten by autoLayout below
			};
		});

		// Linear chain of edges
		const newEdges: VisualEdge[] = localIds.slice(0, -1).map((fromId, i) => ({
			fromStepKey: fromId,
			toStepKey: localIds[i + 1],
			condition: undefined,
		}));

		// Compute positions via autoLayout
		const layoutSteps: WorkflowNode[] = newNodes.map((n) => ({
			id: n.step.localId,
			name: n.step.name,
			agentId: n.step.agentId,
			instructions: n.step.instructions || undefined,
		}));
		const layoutTransitions: VisualTransition[] = newEdges.map((e, i) => ({
			id: `t-${i}`,
			from: e.fromStepKey,
			to: e.toStepKey,
			order: i,
		}));

		const positions = autoLayout(layoutSteps, layoutTransitions, firstLocalId);

		const positionedNodes: VisualNode[] = newNodes.map((n) => ({
			...n,
			position: positions.get(n.step.localId) ?? n.position,
		}));

		// Re-inject the Task Agent virtual node at the position autoLayout computed for it.
		// applyTemplate replaces the entire nodes array, so without this the Task Agent
		// would be evicted even in edit mode (where it was previously present).
		const taskAgentVisualNode: VisualNode = {
			step: {
				localId: TASK_AGENT_NODE_ID,
				id: TASK_AGENT_NODE_ID,
				name: 'Task Agent',
				agentId: '',
				instructions: '',
			},
			position: positions.get(TASK_AGENT_NODE_ID) ?? TASK_AGENT_INITIAL_POSITION,
		};
		setNodes([taskAgentVisualNode, ...positionedNodes]);
		setEdges(newEdges);
		setStartStepId(firstLocalId);
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
		setShowTemplates(false);
		if (!name) setName(template.label);

		// Fit viewport to the new layout
		const container = canvasContainerRef.current;
		if (container) {
			const nodePositions: NodePosition = {};
			for (const n of positionedNodes) {
				nodePositions[n.step.localId] = {
					x: n.position.x,
					y: n.position.y,
					width: DEFAULT_NODE_WIDTH,
					height: DEFAULT_NODE_HEIGHT,
				};
			}
			setViewportState(
				computeFitToView(nodePositions, container.clientWidth, container.clientHeight)
			);
		} else {
			setViewportState({ offsetX: 0, offsetY: 0, scale: 1 });
		}
	}

	// ------------------------------------------------------------------
	// Save
	// ------------------------------------------------------------------

	async function handleSave() {
		if (!name.trim()) {
			setError('Workflow name is required.');
			return;
		}
		// Exclude the Task Agent virtual node from validation — it's never persisted.
		// Match the same dual-check used in serialization.ts to be consistent.
		const regularNodes = nodes.filter(
			(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
		);

		if (regularNodes.length === 0) {
			setError('A workflow must have at least one step.');
			return;
		}

		// Validate each step has an agent assigned (single or multi-agent)
		for (let i = 0; i < regularNodes.length; i++) {
			const step = regularNodes[i].step;
			const hasMultiAgent = Array.isArray(step.agents) && step.agents.length > 0;
			if (!hasMultiAgent && !step.agentId) {
				setError(`Step ${i + 1} requires an agent.`);
				return;
			}
		}

		// Validate condition-type edges have a non-empty expression
		for (const edge of edges) {
			if (edge.condition?.type === 'condition' && !edge.condition.expression?.trim()) {
				setError('A transition using "Expression" condition requires a non-empty expression.');
				return;
			}
		}

		const visualState: VisualEditorState = { nodes, edges, startNodeId, rules, tags, channels };

		setSaving(true);
		setError(null);

		try {
			if (isEditing && workflow) {
				const params = visualStateToUpdateParams(visualState, {
					name: name.trim(),
					description: description.trim() || null,
				});
				await spaceStore.updateWorkflow(workflow.id, params);
			} else {
				// visualStateToCreateParams requires a spaceId argument, but
				// spaceStore.createWorkflow already injects the active spaceId itself.
				// We pass an empty string as a placeholder and strip it before calling
				// the store so the call signature stays consistent.
				const fullParams = visualStateToCreateParams(
					visualState,
					'', // stripped below — store provides the real spaceId
					name.trim(),
					description.trim() || undefined
				);
				const { spaceId: _spaceId, ...createParams } = fullParams;
				await spaceStore.createWorkflow(createParams);
			}
			onSave();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save workflow.');
		} finally {
			setSaving(false);
		}
	}

	// ------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------

	return (
		<div data-testid="visual-workflow-editor" class="flex flex-col h-full overflow-hidden">
			{/* ---- Header ---- */}
			<div class="flex items-center gap-3 px-6 py-4 border-b border-dark-700 flex-shrink-0">
				<button
					onClick={onCancel}
					class="text-gray-500 hover:text-gray-300 transition-colors"
					title="Back"
					data-testid="back-button"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
				<h1 class="text-sm font-semibold text-gray-100">
					{isEditing ? 'Edit Workflow' : 'New Workflow'}
				</h1>

				{/* Inline name / description inputs */}
				<div class="flex-1 flex items-center gap-3 min-w-0">
					<input
						type="text"
						value={name}
						onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
						placeholder="Workflow name…"
						data-testid="workflow-name-input"
						class="flex-1 min-w-0 text-sm bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
					/>
					<input
						type="text"
						value={description}
						onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
						placeholder="Description (optional)"
						data-testid="workflow-description-input"
						class="flex-1 min-w-0 text-sm bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-500 focus:outline-none focus:border-blue-500 placeholder-gray-600"
					/>
				</div>

				<button
					onClick={onCancel}
					class="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
					data-testid="cancel-button"
				>
					Cancel
				</button>
				<button
					onClick={handleSave}
					disabled={saving}
					data-testid="save-button"
					class="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
				>
					{saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Workflow'}
				</button>
			</div>

			{/* ---- Error banner ---- */}
			{error && (
				<div class="px-6 py-2 bg-red-900/20 border-b border-red-800/40 flex-shrink-0">
					<p class="text-xs text-red-300">{error}</p>
				</div>
			)}

			{/* ---- Canvas area ---- */}
			<div ref={canvasContainerRef} class="flex-1 relative overflow-hidden bg-dark-950">
				{/* Add Step + Template toolbar */}
				<div
					class="absolute top-3 left-3 z-10 flex items-center gap-2"
					style={{ pointerEvents: 'auto' }}
				>
					<button
						onClick={addStep}
						data-testid="add-step-button"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-dark-800 border border-dark-600 rounded text-gray-300 hover:text-white hover:bg-dark-700 hover:border-dark-500 transition-colors shadow"
					>
						<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Add Step
					</button>

					{/* Template picker — only shown when creating a new workflow with no steps yet */}
					{!isEditing &&
						nodes.filter(
							(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
						).length === 0 && (
							<div class="relative">
								<button
									onClick={() => setShowTemplates((v) => !v)}
									data-testid="template-picker-button"
									class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-dark-800 border border-dark-600 rounded text-gray-300 hover:text-white hover:bg-dark-700 hover:border-dark-500 transition-colors shadow"
								>
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M4 6h16M4 10h16M4 14h8"
										/>
									</svg>
									From Template
									<svg
										class={`w-3 h-3 transition-transform ${showTemplates ? 'rotate-180' : ''}`}
										fill="none"
										viewBox="0 0 24 24"
										stroke="currentColor"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width={2}
											d="M19 9l-7 7-7-7"
										/>
									</svg>
								</button>

								{showTemplates && (
									<div class="absolute top-full left-0 mt-1 w-64 bg-dark-800 border border-dark-600 rounded shadow-lg z-20 overflow-hidden">
										{TEMPLATES.map((t) => (
											<button
												key={t.label}
												onClick={() => applyTemplate(t)}
												data-testid="template-option"
												data-template-label={t.label}
												class="w-full text-left px-3 py-2.5 hover:bg-dark-700 transition-colors border-b border-dark-700 last:border-b-0"
											>
												<div class="text-xs font-medium text-gray-200">{t.label}</div>
												<div class="text-xs text-gray-500 mt-0.5">{t.description}</div>
											</button>
										))}
									</div>
								)}
							</div>
						)}
				</div>

				{/* Empty state overlay — shown when no regular steps exist (Task Agent doesn't count) */}
				{nodes.filter(
					(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
				).length === 0 && (
					<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
						<div class="text-center">
							<p class="text-sm text-gray-600">No steps yet.</p>
							<p class="text-xs text-gray-700 mt-1">Click "Add Step" to start building.</p>
						</div>
					</div>
				)}

				<WorkflowCanvas
					nodes={nodeData}
					viewportState={viewportState}
					onViewportChange={setViewportState}
					transitions={[]}
					channels={channelEdges}
					onNodeSelect={handleNodeSelect}
					onDeleteNode={handleDeleteNode}
					onNodePositionChange={handleNodePositionChange}
					onCreateTransition={handleCreateTransition}
					onEdgeSelect={handleEdgeSelect}
					onDeleteEdge={handleDeleteEdge}
					onChannelSelect={handleChannelSelect}
					selectedChannelId={selectedChannelId}
				/>

				{/* NodeConfigPanel — anchored to the right of the canvas.
				    isFirstStep/isLastStep indicate whether the node has no incoming/outgoing
				    edges respectively. In a DAG this means every source node shows "Workflow
				    starts here" and every sink node shows "Workflow ends here", which is the
				    correct terminal-message semantic for a non-linear workflow. */}
				{selectedNode && (
					<NodeConfigPanel
						step={selectedNode.step}
						agents={agents}
						entryCondition={getEntryCondition(selectedNode)}
						exitCondition={getExitCondition(selectedNode)}
						isStartNode={nodeIsStart(selectedNode)}
						isFirstStep={
							!edges.some(
								(e) => e.toStepKey === (selectedNode.step.id ?? selectedNode.step.localId)
							)
						}
						isLastStep={
							!edges.some(
								(e) => e.fromStepKey === (selectedNode.step.id ?? selectedNode.step.localId)
							)
						}
						onUpdate={handleUpdateNode}
						onUpdateEntryCondition={(c) => handleUpdateEntryCondition(selectedNode, c)}
						onUpdateExitCondition={(c) => handleUpdateExitCondition(selectedNode, c)}
						onSetAsStart={handleSetAsStart}
						onClose={() => setSelectedNodeId(null)}
						onDelete={handleDeleteNode}
					/>
				)}

				{/* EdgeConfigPanel — floating panel in the bottom-left of the canvas */}
				{selectedEdgeInfo && (
					<div class="absolute bottom-16 left-3 w-72 z-20" style={{ pointerEvents: 'auto' }}>
						<EdgeConfigPanel
							transition={{
								id: selectedEdgeId!,
								fromStepName: selectedEdgeInfo.fromNode.step.name || 'Unnamed',
								toStepName: selectedEdgeInfo.toNode.step.name || 'Unnamed',
								condition: selectedEdgeInfo.edge?.condition ?? { type: 'always' },
							}}
							onUpdateCondition={handleUpdateEdgeCondition}
							onDelete={handleDeleteEdge}
							onClose={() => setSelectedEdgeId(null)}
						/>
					</div>
				)}
			</div>

			{/* ---- Tags and Rules (collapsible) ---- */}
			<div class="flex-shrink-0 border-t border-dark-700 max-h-64 overflow-y-auto">
				{/* Tags row */}
				<div class="px-4 py-3 border-b border-dark-800">
					<div class="flex items-center gap-2 mb-2">
						<span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tags</span>
						<div class="flex flex-wrap gap-1">
							{tags.map((tag) => (
								<span
									key={tag}
									class="flex items-center gap-1 text-xs bg-dark-700 border border-dark-600 text-gray-300 rounded px-1.5 py-0.5"
								>
									{tag}
									<button
										type="button"
										onClick={() => removeTag(tag)}
										class="text-gray-500 hover:text-red-400 transition-colors"
										aria-label={`Remove tag ${tag}`}
									>
										×
									</button>
								</span>
							))}
							<input
								type="text"
								value={tagInput}
								placeholder={tags.length === 0 ? 'Add tags…' : ''}
								onInput={(e) => setTagInput((e.currentTarget as HTMLInputElement).value)}
								onKeyDown={handleTagInputKeyDown}
								onBlur={() => {
									if (tagInput.trim()) {
										tagInput.split(',').forEach((t) => addTag(t));
										setTagInput('');
									}
								}}
								class="text-xs bg-transparent text-gray-300 outline-none placeholder-gray-700 min-w-[6rem]"
							/>
						</div>
						{/* Tag suggestions */}
						<div class="flex gap-1 ml-auto">
							{TAG_SUGGESTIONS.filter((s) => !tags.includes(s)).map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => addTag(s)}
									class="text-xs text-gray-600 hover:text-gray-300 border border-dark-700 hover:border-dark-500 rounded px-1.5 py-0.5 transition-colors"
								>
									+{s}
								</button>
							))}
						</div>
					</div>
				</div>

				{/* Channels — collapsible section for workflow-level channel management */}
				<div class="px-4 py-2 border-b border-dark-800">
					<button
						onClick={() => setShowChannels((v) => !v)}
						class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
						data-testid="toggle-channels-button"
					>
						<svg
							class={`w-3 h-3 transition-transform ${showChannels ? 'rotate-90' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span class="font-semibold uppercase tracking-wider">
							Channels {channels.length > 0 ? `(${channels.length})` : ''}
						</span>
					</button>

					{showChannels && (
						<div class="mt-3" data-testid="channels-section">
							<ChannelEditor
								channels={channels}
								onChange={setChannels}
								agentRoles={agentRoles}
								highlightIndex={selectedChannelId != null ? parseInt(selectedChannelId, 10) : null}
							/>
						</div>
					)}
				</div>

				{/* Rules — collapsible */}
				<div class="px-4 py-2">
					<button
						onClick={() => setShowRules((v) => !v)}
						class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
						data-testid="toggle-rules-button"
					>
						<svg
							class={`w-3 h-3 transition-transform ${showRules ? 'rotate-90' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span class="font-semibold uppercase tracking-wider">
							Rules {rules.length > 0 ? `(${rules.length})` : ''}
						</span>
					</button>

					{showRules && (
						<div class="mt-3">
							<WorkflowRulesEditor
								rules={rules}
								steps={nodes.map((n, i) => ({
									id: n.step.id ?? n.step.localId,
									name: n.step.name || `Step ${i + 1}`,
									agentId: n.step.agentId,
									instructions: n.step.instructions,
								}))}
								onChange={setRules}
							/>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
