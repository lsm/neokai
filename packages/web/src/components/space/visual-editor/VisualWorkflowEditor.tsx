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

import { useState, useMemo, useCallback, useRef, useEffect } from 'preact/hooks';
import type {
	SpaceWorkflow,
	WorkflowNode,
	WorkflowConditionType,
	WorkflowChannel,
} from '@neokai/shared';
import { generateUUID, TASK_AGENT_NODE_ID } from '@neokai/shared';
import { spaceStore } from '../../../lib/space-store';
import { filterAgents, TEMPLATES, buildTemplateNodes } from '../WorkflowEditor';
import type { WorkflowTemplate } from '../WorkflowEditor';
import { WorkflowRulesEditor } from '../WorkflowRulesEditor';
import { ConfirmModal } from '../../ui/ConfirmModal';
import type { RuleDraft } from '../WorkflowRulesEditor';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import type { ViewportState, Point, VisualTransition } from './types';
import type { VisualNode, VisualEdge, VisualEditorState } from './serialization';
import {
	workflowToVisualState,
	visualStateToCreateParams,
	visualStateToUpdateParams,
} from './serialization';
import type { WorkflowNodeData } from './WorkflowCanvas';
import { WorkflowCanvas } from './WorkflowCanvas';
import { computeFitToView } from './CanvasToolbar';
import { autoLayout } from './layout';
import type { NodePosition } from './types';
import { NodeConfigPanel } from './NodeConfigPanel';
import type { NodeChannelLink } from './NodeConfigPanel';
import { EdgeConfigPanel } from './EdgeConfigPanel';
import { ChannelRelationConfigPanel } from './ChannelRelationConfigPanel';
import { buildVisualNodePositions } from './nodeMetrics';
import {
	buildNodeAnchorUsage,
	buildSemanticWorkflowEdges,
	routeSemanticWorkflowEdges,
} from './semanticWorkflowGraph';

// ============================================================================
// Constants
// ============================================================================

const TAG_SUGGESTIONS = ['coding', 'review', 'research', 'design', 'deployment'];

function buildTemplateCanvasSignature(
	nodes: VisualNode[],
	edges: VisualEdge[],
	channels: WorkflowChannel[],
	startNodeId: string
): string {
	const regularNodes = nodes
		.filter((node) => node.step.localId !== TASK_AGENT_NODE_ID && node.step.id !== TASK_AGENT_NODE_ID)
		.map((node) => ({
			localId: node.step.localId,
			id: node.step.id ?? null,
			name: node.step.name,
			agentId: node.step.agentId ?? null,
			model: node.step.model ?? null,
			systemPrompt: node.step.systemPrompt ?? null,
			instructions: node.step.instructions ?? '',
			agents:
				node.step.agents?.map((agent) => ({
					agentId: agent.agentId ?? null,
					name: agent.name ?? '',
					model: agent.model ?? null,
					systemPrompt: agent.systemPrompt ?? null,
					instructions: agent.instructions ?? '',
				})) ?? [],
			nodeChannels:
				node.step.channels?.map((channel) => ({
					from: channel.from,
					to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
					direction: channel.direction,
					gate: channel.gate ? { ...channel.gate } : undefined,
				})) ?? [],
			position: { x: node.position.x, y: node.position.y },
		}))
		.sort((a, b) => a.localId.localeCompare(b.localId));

	const normalizedEdges = edges
		.map((edge) => ({
			fromStepKey: edge.fromStepKey,
			toStepKey: edge.toStepKey,
			condition: edge.condition ? { ...edge.condition } : undefined,
		}))
		.sort((a, b) =>
			`${a.fromStepKey}:${a.toStepKey}`.localeCompare(`${b.fromStepKey}:${b.toStepKey}`)
		);

	const normalizedChannels = channels
		.map((channel) => ({
			from: channel.from,
			to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
			direction: channel.direction,
			gate: channel.gate ? { ...channel.gate } : undefined,
		}))
		.sort((a, b) => `${a.from}:${String(a.to)}`.localeCompare(`${b.from}:${String(b.to)}`));

	return JSON.stringify({
		nodes: regularNodes,
		edges: normalizedEdges,
		channels: normalizedChannels,
		startNodeId,
	});
}

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
				position: { x: 0, y: 0 },
			},
		];
	});
	const [edges, setEdges] = useState<VisualEdge[]>(() => initState?.edges ?? []);
	const [rules, setRules] = useState<RuleDraft[]>(() => initState?.rules ?? []);
	const [tags, setTags] = useState<string[]>(() => initState?.tags ?? []);
	const [startNodeId, setStartStepId] = useState<string>(() => initState?.startNodeId ?? '');
	const [channels, setChannels] = useState<WorkflowChannel[]>(() => initState?.channels ?? []);
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

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRules, setShowRules] = useState(false);
	const [showTemplates, setShowTemplates] = useState(false);
	const [tagInput, setTagInput] = useState('');
	const [pendingTemplate, setPendingTemplate] = useState<WorkflowTemplate | null>(null);

	const canvasContainerRef = useRef<HTMLDivElement>(null);

	const agents = filterAgents(spaceStore.agents.value);
	const tasksByNodeId = spaceStore.tasksByNodeId.value;
	const regularNodes = useMemo(
		() =>
			nodes.filter(
				(node) => node.step.id !== TASK_AGENT_NODE_ID && node.step.localId !== TASK_AGENT_NODE_ID
			),
		[nodes]
	);
	const currentTemplateCanvasSignature = useMemo(
		() => buildTemplateCanvasSignature(nodes, edges, channels, startNodeId),
		[nodes, edges, channels, startNodeId]
	);
	const [templateBaselineSignature, setTemplateBaselineSignature] = useState(() =>
		buildTemplateCanvasSignature(
			initState?.nodes ?? [
				{
					step: {
						localId: TASK_AGENT_NODE_ID,
						id: TASK_AGENT_NODE_ID,
						name: 'Task Agent',
						agentId: '',
						instructions: '',
					},
					position: { x: 0, y: 0 },
				},
			],
			initState?.edges ?? [],
			initState?.channels ?? [],
			initState?.startNodeId ?? ''
		)
	);

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

	const endpointNodeIdLookup = useMemo(() => {
		const map = new Map<string, string>();
		for (const node of nodes) {
			if (node.step.localId === TASK_AGENT_NODE_ID || node.step.id === TASK_AGENT_NODE_ID) continue;
			if (node.step.agentId) map.set(node.step.agentId, node.step.localId);
			if (node.step.name) map.set(node.step.name, node.step.localId);
			for (const agent of node.step.agents ?? []) {
				if (agent.name) map.set(agent.name, node.step.localId);
				if (agent.agentId) map.set(agent.agentId, node.step.localId);
			}
		}
		return map;
	}, [nodes]);

	// ------------------------------------------------------------------
	// Derived: ResolvedWorkflowChannel[] for workflow-level channel connections.
	// Resolves channel from/to agent role names to node localIds so EdgeRenderer
	// can render the edges. Includes gate type and ID for visual distinction + selection.
	// ------------------------------------------------------------------

	const semanticEdges = useMemo(
		() => buildSemanticWorkflowEdges(nodes, channels),
		[nodes, channels]
	);

	const routedSemanticEdges = useMemo(
		() => routeSemanticWorkflowEdges(nodes, semanticEdges),
		[nodes, semanticEdges]
	);

	const anchorUsageByNodeId = useMemo(
		() => buildNodeAnchorUsage(routedSemanticEdges),
		[routedSemanticEdges]
	);

	const channelEdges = useMemo<
		{
			fromStepId: string;
			toStepId: string;
			direction: 'one-way' | 'bidirectional';
			gateType?: 'human' | 'condition' | 'task_result';
			sourceSide?: 'top' | 'bottom' | 'left' | 'right';
			targetSide?: 'top' | 'bottom' | 'left' | 'right';
			id?: string;
			label?: string;
		}[]
		>(() => {
			return routedSemanticEdges.map((edge) => ({
				fromStepId: edge.fromStepId,
				toStepId: edge.toStepId,
				direction: edge.direction,
				gateType: edge.gateType,
				sourceSide: edge.sourceSide,
				targetSide: edge.targetSide,
				id: edge.id,
			}));
		}, [routedSemanticEdges]);

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

	// ------------------------------------------------------------------
	// Derived: WorkflowNodeData[] for WorkflowCanvas
	// ------------------------------------------------------------------

	const nodeData = useMemo<WorkflowNodeData[]>(() => {
		return regularNodes.map((node, i) => {
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
				activeAnchorSides: anchorUsageByNodeId.get(node.step.localId) ?? [],
				nodeTaskStates: nodeTaskStates.length > 0 ? nodeTaskStates : undefined,
			};
		});
	}, [regularNodes, agents, channels, nodeIsStart, tasksByNodeId, relevantRunId, anchorUsageByNodeId]);

	const canvasNodePositions = useMemo<NodePosition>(
		() => buildVisualNodePositions(regularNodes),
		[regularNodes]
	);

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

	const selectedChannelInfo = useMemo(() => {
		if (selectedChannelId == null) return null;
		const relation = routedSemanticEdges.find((edge) => edge.id === selectedChannelId);
		if (!relation) return null;
		const fromNode = nodes.find((n) => n.step.localId === relation.fromStepId) ?? null;
		const toNode = nodes.find((n) => n.step.localId === relation.toStepId) ?? null;
		const links = Array.from(new Set(relation.channelIndexes))
			.map((index) => {
				const channel = channels[index];
				return channel ? { index, channel } : null;
			})
			.filter((entry): entry is { index: number; channel: WorkflowChannel } => !!entry);

		const resolveTargetNodeIds = (channel: WorkflowChannel) => {
			const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
			return targets
				.map((target) => endpointNodeIdLookup.get(target) ?? null)
				.filter((nodeId): nodeId is string => !!nodeId);
		};

		const forwardLinks = links.filter(({ channel }) => {
			const fromId = endpointNodeIdLookup.get(channel.from);
			const targetIds = resolveTargetNodeIds(channel);
			return fromId === relation.fromStepId && targetIds.includes(relation.toStepId);
		});

		const reverseLinks = links.filter(({ channel }) => {
			const fromId = endpointNodeIdLookup.get(channel.from);
			const targetIds = resolveTargetNodeIds(channel);
			return fromId === relation.toStepId && targetIds.includes(relation.fromStepId);
		});

		const visibleLinkCount = forwardLinks.length + reverseLinks.length;
		const relationIsBidirectional = reverseLinks.length > 0 || relation.direction === 'bidirectional';

		return {
			relation,
			fromNode,
			toNode,
			links,
			forwardLinks,
			reverseLinks,
			relationIsBidirectional,
			visibleLinkCount,
			canConvertToBidirectional: forwardLinks.length > 0 && reverseLinks.length === 0,
			relationLabel:
				relationIsBidirectional
					? `${fromNode?.step.name || 'Unnamed'} ↔ ${toNode?.step.name || 'Unnamed'}`
					: `${fromNode?.step.name || 'Unnamed'} → ${toNode?.step.name || 'Unnamed'}`,
		};
	}, [selectedChannelId, routedSemanticEdges, nodes, channels, endpointNodeIdLookup]);

	const nodeChannelLinksByNodeId = useMemo(() => {
		const linksByNodeId = new Map<string, NodeChannelLink[]>();

		for (const edge of routedSemanticEdges) {
			const fromNode = nodes.find((n) => n.step.localId === edge.fromStepId);
			const toNode = nodes.find((n) => n.step.localId === edge.toStepId);
			if (!fromNode || !toNode) continue;

			const link: NodeChannelLink = {
				id: edge.id,
				label:
					edge.direction === 'bidirectional'
						? `${fromNode.step.name || 'Unnamed'} ↔ ${toNode.step.name || 'Unnamed'}`
						: `${fromNode.step.name || 'Unnamed'} → ${toNode.step.name || 'Unnamed'}`,
				direction: edge.direction,
				channelCount: edge.channelCount,
				hasGate: edge.hasGate,
			};

			linksByNodeId.set(edge.fromStepId, [...(linksByNodeId.get(edge.fromStepId) ?? []), link]);
			linksByNodeId.set(edge.toStepId, [...(linksByNodeId.get(edge.toStepId) ?? []), link]);
		}

		return linksByNodeId;
	}, [nodes, routedSemanticEdges]);

	useEffect(() => {
		if (!selectedChannelInfo) return;

		const legacyBidirectionalLinks = selectedChannelInfo.forwardLinks.filter(
			({ channel }) => channel.direction === 'bidirectional'
		);
		if (legacyBidirectionalLinks.length === 0 || selectedChannelInfo.reverseLinks.length > 0) return;

		setChannels((prev) => {
			const next = [...prev];
			let changed = false;

			for (const { index, channel } of legacyBidirectionalLinks) {
				const current = next[index];
				if (!current || current.direction !== 'bidirectional') continue;

				next[index] = {
					...current,
					direction: 'one-way',
					gate: current.gate ? { ...current.gate } : undefined,
				};

				const targets = Array.isArray(current.to) ? current.to : [current.to];
				for (const target of targets) {
					const reverseExists = next.some(
						(existing) =>
							existing.from === target &&
							(Array.isArray(existing.to) ? existing.to.includes(current.from) : existing.to === current.from)
					);
					if (reverseExists) continue;

					next.push({
						from: target,
						to: current.from,
						direction: 'one-way',
						isCyclic: current.isCyclic,
						gate: current.gate ? { ...current.gate } : undefined,
					});
				}
				changed = true;
			}

			return changed ? next : prev;
		});
	}, [selectedChannelInfo]);

	// ------------------------------------------------------------------
	// Node operations
	// ------------------------------------------------------------------

	function addStep() {
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

			// Auto-set start step for the first regular node (pure — reads from prev).
			const isFirstRegular = regularCount === 0;
			if (isFirstRegular) setStartStepId(newLocalId);

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
		if (localId) {
			setSelectedEdgeId(null);
			setSelectedChannelId(null);
		}
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
		}
	}, []);

	const handleChannelSelectFromNodePanel = useCallback((channelId: string | null) => {
		setSelectedChannelId(channelId);
		if (channelId) {
			setSelectedEdgeId(null);
		}
	}, []);

	const resolveSourceChannelNames = useCallback((node: VisualNode): string[] => {
		if (node.step.agents && node.step.agents.length > 0) {
			return node.step.agents.map((a) => a.name).filter((name) => name.trim().length > 0);
		}
		if (node.step.name?.trim()) return [node.step.name.trim()];
		if (node.step.agentId?.trim()) return [node.step.agentId.trim()];
		return [];
	}, []);

	const resolveTargetChannelName = useCallback((node: VisualNode): string | null => {
		// For multi-agent targets, route to the node name so delivery fans out to
		// all agents in that node.
		if (node.step.agents && node.step.agents.length > 1) {
			return node.step.name?.trim() || null;
		}
		if (node.step.agents && node.step.agents.length === 1) {
			return node.step.agents[0]?.name?.trim() || null;
		}
		if (node.step.name?.trim()) return node.step.name.trim();
		if (node.step.agentId?.trim()) return node.step.agentId.trim();
		return null;
	}, []);

	const handleCreateTransition = useCallback(
		(fromLocalId: string, toLocalId: string) => {
			// Task Agent is not a workflow node — prevent creating channels to/from it.
			if (fromLocalId === TASK_AGENT_NODE_ID || toLocalId === TASK_AGENT_NODE_ID) return;

			const fromNode = nodes.find((n) => n.step.localId === fromLocalId);
			const toNode = nodes.find((n) => n.step.localId === toLocalId);
			if (!fromNode || !toNode) return;

			const fromNames = resolveSourceChannelNames(fromNode);
			const toName = resolveTargetChannelName(toNode);
			if (!toName || fromNames.length === 0) return;

			setChannels((prev) => {
				const next = [...prev];
				for (const fromName of fromNames) {
					// Deduplicate exact same directed channel produced by repeated drags.
					if (
						next.some(
							(ch) =>
								ch.from === fromName &&
								!Array.isArray(ch.to) &&
								ch.to === toName &&
								ch.direction === 'one-way'
						)
					) {
						continue;
					}
					next.push({
						from: fromName,
						to: toName,
						direction: 'one-way',
					});
				}
				return next;
			});
		},
		[nodes, resolveSourceChannelNames, resolveTargetChannelName]
	);

	const handleUpdateChannelFromEdgePanel = useCallback(
		(index: number, channel: WorkflowChannel) => {
			setChannels((prev) => prev.map((ch, i) => (i === index ? channel : ch)));
		},
		[]
	);

	const handleDeleteChannelFromEdgePanel = useCallback((index: number) => {
		setChannels((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleConvertChannelRelationToBidirectional = useCallback(() => {
		if (!selectedChannelInfo?.fromNode || !selectedChannelInfo.toNode) return;

		const reverseSourceNames = resolveSourceChannelNames(selectedChannelInfo.toNode);
		const reverseTargetName = resolveTargetChannelName(selectedChannelInfo.fromNode);
		if (reverseSourceNames.length === 0 || !reverseTargetName) return;

		const relationFromStepId = selectedChannelInfo.relation.fromStepId;
		const relationToStepId = selectedChannelInfo.relation.toStepId;

		setChannels((prev) => {
			const next = [...prev];

			for (const fromName of reverseSourceNames) {
				const reverseAlreadyExists = next.some((channel) => {
					const fromId = endpointNodeIdLookup.get(channel.from);
					const targetValues = Array.isArray(channel.to) ? channel.to : [channel.to];
					const targetNodeIds = targetValues
						.map((target) => endpointNodeIdLookup.get(target) ?? null)
						.filter((nodeId): nodeId is string => !!nodeId);

					return (
						fromId === relationToStepId &&
						targetNodeIds.includes(relationFromStepId) &&
						channel.from === fromName &&
						targetValues.includes(reverseTargetName)
					);
				});

				if (reverseAlreadyExists) continue;

				next.push({
					from: fromName,
					to: reverseTargetName,
					direction: 'one-way',
				});
			}

			return next;
		});
	}, [
		selectedChannelInfo,
		resolveSourceChannelNames,
		resolveTargetChannelName,
		endpointNodeIdLookup,
	]);

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
		const templateSteps = buildTemplateNodes(template, agents);
		if (templateSteps.length === 0) return;
		const firstLocalId = templateSteps[0].localId;

		const newNodes: VisualNode[] = templateSteps.map((step) => ({
			step: {
				...step,
				agents: step.agents?.map((slot) => ({ ...slot })),
				channels: step.channels?.map((channel) => ({
					...channel,
					to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
					gate: channel.gate ? { ...channel.gate } : undefined,
				})),
			},
			position: { x: 0, y: 0 }, // overwritten by autoLayout below
		}));

		const localIds = templateSteps.map((step) => step.localId);

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
			agents: n.step.agents?.map((slot) => ({ ...slot })),
			model: n.step.model,
			systemPrompt: n.step.systemPrompt,
			instructions: n.step.instructions || undefined,
		}));
		const layoutTransitions: VisualTransition[] = newEdges.map((e, i) => ({
			id: `t-${i}`,
			from: e.fromStepKey,
			to: e.toStepKey,
			order: i,
		}));

		const positions = autoLayout(layoutSteps, layoutTransitions, firstLocalId, template.channels ?? []);

		const positionedNodes: VisualNode[] = newNodes.map((n) => ({
			...n,
			position: positions.get(n.step.localId) ?? n.position,
		}));

		const taskAgentVisualNode: VisualNode = {
			step: {
				localId: TASK_AGENT_NODE_ID,
				id: TASK_AGENT_NODE_ID,
				name: 'Task Agent',
				agentId: '',
				instructions: '',
			},
			position: { x: 0, y: 0 },
		};
		const nextNodes = [taskAgentVisualNode, ...positionedNodes];
		const nextChannels = (template.channels ?? []).map((channel) => ({
			...channel,
			to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
			gate: channel.gate ? { ...channel.gate } : undefined,
		}));

		setNodes(nextNodes);
		setEdges(newEdges);
		setChannels(nextChannels);
		if (template.tags) {
			setTags([...template.tags]);
		}
		setStartStepId(firstLocalId);
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
		setShowTemplates(false);
		setPendingTemplate(null);
		setTemplateBaselineSignature(
			buildTemplateCanvasSignature(nextNodes, newEdges, nextChannels, firstLocalId)
		);
		if (!name) setName(template.label);

		// Fit viewport to the new layout
		const container = canvasContainerRef.current;
		if (container) {
			setViewportState(
				computeFitToView(
					buildVisualNodePositions(positionedNodes),
					container.clientWidth,
					container.clientHeight
				)
			);
		} else {
			setViewportState({ offsetX: 0, offsetY: 0, scale: 1 });
		}
	}

	function handleTemplateSelection(template: WorkflowTemplate) {
		setShowTemplates(false);
		if (currentTemplateCanvasSignature !== templateBaselineSignature) {
			setPendingTemplate(template);
			return;
		}
		applyTemplate(template);
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
			setError('A workflow must have at least one node.');
			return;
		}

		// Validate each node has an agent assigned (single or multi-agent)
		for (let i = 0; i < regularNodes.length; i++) {
			const step = regularNodes[i].step;
			const hasMultiAgent = Array.isArray(step.agents) && step.agents.length > 0;
			if (!hasMultiAgent && !step.agentId) {
				setError(`Node ${i + 1} requires an agent.`);
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
			<div class="flex-1 relative overflow-hidden bg-dark-950">
				{/* Add Node + Template toolbar */}
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
						Add Node
					</button>

					{/* Template picker — always available in create mode.
					    Reapplying prompts only when the canvas has diverged. */}
					{!isEditing && (
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
												onClick={() => handleTemplateSelection(t)}
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
				{regularNodes.length === 0 && (
					<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
						<div class="text-center">
							<p class="text-sm text-gray-600">No nodes yet.</p>
							<p class="text-xs text-gray-700 mt-1">Click "Add Node" to start building.</p>
						</div>
					</div>
				)}

				<div class="h-full min-h-0 p-3 pt-16">
					<div
						ref={canvasContainerRef}
						class="relative h-full min-h-0 overflow-hidden rounded-xl border border-dark-700 bg-dark-950"
						data-testid="native-workflow-canvas-panel"
					>
						<div class="pointer-events-none absolute left-3 top-3 z-10 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
							Current Canvas
						</div>
						<div
							data-testid="task-agent-overlay"
							class="absolute right-3 top-3 z-20 rounded-xl border border-amber-400 bg-amber-950/95 px-4 py-3 shadow-lg"
						>
							<div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
								Task Agent
							</div>
							<div class="mt-1 text-sm text-amber-100">Always available coordinator</div>
							<div class="mt-1 text-xs text-amber-200/70">
								Implicitly reachable by every workflow node.
							</div>
						</div>
						<WorkflowCanvas
							nodes={nodeData}
							nodePositions={canvasNodePositions}
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
					</div>
				</div>

				{/* NodeConfigPanel — anchored to the right of the canvas.
				    isFirstStep/isLastStep indicate whether the node has no incoming/outgoing
				    edges respectively. In a DAG this means every source node shows "Workflow
				    starts here" and every sink node shows "Workflow ends here", which is the
				    correct terminal-message semantic for a non-linear workflow. */}
				{selectedNode && (
					<NodeConfigPanel
						step={selectedNode.step}
						agents={agents}
						isStartNode={nodeIsStart(selectedNode)}
						onUpdate={handleUpdateNode}
						onSetAsStart={handleSetAsStart}
						channelLinks={nodeChannelLinksByNodeId.get(selectedNode.step.localId) ?? []}
						onOpenChannelLink={handleChannelSelectFromNodePanel}
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

				{/* ChannelRelationConfigPanel — edit underlying channel links for a semantic relation */}
				{selectedChannelInfo && (
					<ChannelRelationConfigPanel
						title="Channel Links"
						description={`${selectedChannelInfo.relationLabel} · ${selectedChannelInfo.visibleLinkCount} editable link${selectedChannelInfo.visibleLinkCount === 1 ? '' : 's'}`}
						forwardLinks={selectedChannelInfo.forwardLinks}
						reverseLinks={selectedChannelInfo.reverseLinks}
						canConvertToBidirectional={selectedChannelInfo.canConvertToBidirectional}
						onConvertToBidirectional={handleConvertChannelRelationToBidirectional}
						onChange={handleUpdateChannelFromEdgePanel}
						onDelete={handleDeleteChannelFromEdgePanel}
						onBack={selectedNode ? () => setSelectedChannelId(null) : undefined}
						onClose={() => setSelectedChannelId(null)}
						width={selectedNode ? 320 : 360}
					/>
				)}

				<ConfirmModal
					isOpen={!!pendingTemplate}
					onClose={() => setPendingTemplate(null)}
					onConfirm={() => {
						if (pendingTemplate) applyTemplate(pendingTemplate);
					}}
					title="Replace current canvas?"
					message="Applying a template will replace the current workflow canvas."
					confirmText="Apply Template"
					confirmButtonVariant="warning"
					confirmTestId="confirm-template-apply-button"
				>
					<p class="text-xs text-gray-500">Current canvas changes will be discarded.</p>
				</ConfirmModal>
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
									name: n.step.name || `Node ${i + 1}`,
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
