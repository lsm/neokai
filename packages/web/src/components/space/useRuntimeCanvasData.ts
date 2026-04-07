/**
 * useRuntimeCanvasData
 *
 * Derives WorkflowNodeData[] and ResolvedWorkflowChannel[] from spaceStore for
 * use in the read-only runtime canvas view.
 *
 * Data sources:
 * - spaceStore.workflows — workflow definition
 * - spaceStore.agents — agent metadata for node cards
 * - spaceStore.nodeExecutionsByNodeId — per-node execution status
 * - hub RPC spaceWorkflowRun.listGateData + space.gateData.updated events
 */

import { useMemo, useState, useEffect, useRef } from 'preact/hooks';
import { isChannelCyclic, TASK_AGENT_NODE_ID } from '@neokai/shared';
import type { Gate, GateField, SpaceWorkflow, WorkflowChannel } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { connectionManager } from '../../lib/connection-manager';
import type { WorkflowNodeData } from './visual-editor/WorkflowCanvas';
import type { ResolvedWorkflowChannel } from './visual-editor/EdgeRenderer';
import type { ViewportState, NodePosition } from './visual-editor/types';
import { workflowToVisualState } from './visual-editor/serialization';
import { buildVisualNodePositions } from './visual-editor/nodeMetrics';
import type { AgentTaskState } from './WorkflowNodeCard';
import {
	buildSemanticWorkflowEdges,
	routeSemanticWorkflowEdges,
	buildNodeAnchorUsage,
} from './visual-editor/semanticWorkflowGraph';

// ---- Gate status evaluation (mirrors logic from old WorkflowCanvas) ----

type GateStatus = 'open' | 'blocked' | 'waiting_human';

interface GateScriptResultData {
	success: boolean;
	reason?: string;
}

function parseScriptResult(data: Record<string, unknown>): { failed: boolean; reason?: string } {
	const sr = data._scriptResult as GateScriptResultData | undefined;
	if (sr && !sr.success) return { failed: true, reason: sr.reason };
	return { failed: false };
}

function evalFieldStatus(field: GateField, data: Record<string, unknown>): GateStatus {
	const check = field.check;
	if (check.op === 'count') {
		const map = data[field.name];
		if (!map || typeof map !== 'object' || Array.isArray(map)) return 'blocked';
		const count = Object.values(map as Record<string, unknown>).filter(
			(v) => v === check.match
		).length;
		return count >= check.min ? 'open' : 'blocked';
	}
	const val = data[field.name];
	if (check.op === 'exists') return val !== undefined ? 'open' : 'blocked';
	if (check.op === '==') return val === check.value ? 'open' : 'blocked';
	if (check.op === '!=') return val !== check.value ? 'open' : 'blocked';
	return 'blocked';
}

function isHumanApprovalGate(fields: GateField[]): boolean {
	return fields.some((f) => f.name === 'approved' && f.writers.includes('human'));
}

function evaluateGateStatus(
	gate: Gate,
	data: Record<string, unknown>,
	scriptFailed = false
): GateStatus {
	if (scriptFailed) return 'blocked';
	if ((gate.fields ?? []).length === 0) return 'open';
	if (isHumanApprovalGate(gate.fields ?? [])) {
		const val = data['approved'];
		if (val === true) {
			const othersPassed = (gate.fields ?? []).every((f) => {
				if (f.name === 'approved') return true;
				return evalFieldStatus(f, data) === 'open';
			});
			return othersPassed ? 'open' : 'blocked';
		}
		if (val === false) return 'blocked';
		return 'waiting_human';
	}
	for (const field of gate.fields ?? []) {
		const status = evalFieldStatus(field, data);
		if (status !== 'open') return status;
	}
	return 'open';
}

// ---- Gate data types ----

interface GateDataRecord {
	runId: string;
	gateId: string;
	data: Record<string, unknown>;
	updatedAt: number;
}

// ---- Hook ----

export interface RuntimeCanvasData {
	nodeData: WorkflowNodeData[];
	channelEdges: ResolvedWorkflowChannel[];
	canvasNodePositions: NodePosition;
	viewportState: ViewportState;
	setViewportState: (state: ViewportState) => void;
	workflow: SpaceWorkflow | null;
	gateDataLoading: boolean;
}

export function useRuntimeCanvasData(
	workflowId: string | null,
	runId: string | null
): RuntimeCanvasData {
	const workflows = spaceStore.workflows.value;
	const agents = spaceStore.agents.value;
	const nodeExecutionsByNodeId = spaceStore.nodeExecutionsByNodeId.value;

	const workflow = workflowId ? (workflows.find((w) => w.id === workflowId) ?? null) : null;

	const [viewportState, setViewportState] = useState<ViewportState>({
		offsetX: 0,
		offsetY: 0,
		scale: 1,
	});

	// ---- Gate data fetching ----
	const [gateDataMap, setGateDataMap] = useState<Map<string, Record<string, unknown>>>(new Map());
	const [gateDataLoading, setGateDataLoading] = useState(false);
	const runIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!runId || !workflow) {
			setGateDataMap(new Map());
			return;
		}
		runIdRef.current = runId;
		setGateDataLoading(true);

		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			setGateDataLoading(false);
			return;
		}

		hub
			.request<{ gateData: GateDataRecord[] }>('spaceWorkflowRun.listGateData', { runId })
			.then((result) => {
				if (runIdRef.current !== runId) return;
				const map = new Map<string, Record<string, unknown>>();
				for (const record of result.gateData) {
					map.set(record.gateId, record.data);
				}
				setGateDataMap(map);
			})
			.catch(() => {})
			.finally(() => {
				if (runIdRef.current === runId) setGateDataLoading(false);
			});

		const unsubscribe = hub.onEvent<{
			runId: string;
			gateId: string;
			data: Record<string, unknown>;
		}>('space.gateData.updated', (event) => {
			if (event.runId !== runId) return;
			setGateDataMap((prev) => {
				const next = new Map(prev);
				next.set(event.gateId, event.data);
				return next;
			});
		});

		return () => {
			unsubscribe?.();
		};
	}, [runId, workflow?.id]);

	// ---- Build visual state from workflow ----
	const visualState = useMemo(
		() => (workflow ? workflowToVisualState(workflow) : null),
		[workflow]
	);

	// ---- Endpoint lookup for channel resolution ----
	const nodes = visualState?.nodes ?? [];
	const channels: WorkflowChannel[] = visualState?.channels ?? [];
	const gates: Gate[] = visualState?.gates ?? [];

	// Compute cyclic channel indexes (same as VisualWorkflowEditor)
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

	const nodeOrderByLocalId = useMemo(
		() =>
			new Map(
				nodes
					.filter((n) => n.step.localId !== TASK_AGENT_NODE_ID && n.step.id !== TASK_AGENT_NODE_ID)
					.map((node, index) => [node.step.localId, index])
			),
		[nodes]
	);

	const cyclicChannelIndexes = useMemo(() => {
		const set = new Set<number>();
		for (let i = 0; i < channels.length; i++) {
			if (isChannelCyclic(i, channels, [], endpointNodeIdLookup, nodeOrderByLocalId)) {
				set.add(i);
			}
		}
		return set;
	}, [channels, endpointNodeIdLookup, nodeOrderByLocalId]);

	const semanticEdges = useMemo(
		() => buildSemanticWorkflowEdges(nodes, channels, gates, cyclicChannelIndexes),
		[nodes, channels, gates, cyclicChannelIndexes]
	);

	const routedSemanticEdges = useMemo(
		() => routeSemanticWorkflowEdges(nodes, semanticEdges),
		[nodes, semanticEdges]
	);

	const anchorUsageByNodeId = useMemo(
		() => buildNodeAnchorUsage(routedSemanticEdges),
		[routedSemanticEdges]
	);

	// ---- Build channel edges with runtime status ----
	const channelEdges = useMemo<ResolvedWorkflowChannel[]>(() => {
		const gateLookup = new Map((gates ?? []).map((g) => [g.id, g]));

		return routedSemanticEdges.map((edge) => {
			// Find the forward gate ID from the channels that make up this edge
			let forwardGateId: string | undefined;

			for (const channelIndex of edge.channelIndexes) {
				const ch = channels[channelIndex];
				if (!ch) continue;
				const fromNodeId = endpointNodeIdLookup.get(ch.from);
				if (fromNodeId === edge.fromStepId) {
					forwardGateId = forwardGateId ?? ch.gateId;
				}
			}

			// Compute runtime status for forward gate
			let runtimeStatus: GateStatus | undefined;
			if (forwardGateId && runId) {
				const gate = gateLookup.get(forwardGateId);
				const data = gateDataMap.get(forwardGateId) ?? {};
				const scriptResult = gate ? parseScriptResult(data) : { failed: false };
				runtimeStatus = gate ? evaluateGateStatus(gate, data, scriptResult.failed) : undefined;
			}

			return {
				fromStepId: edge.fromStepId,
				toStepId: edge.toStepId,
				direction: edge.direction,
				gateType: edge.gateType,
				reverseGateType: edge.reverseGateType,
				gateLabel: edge.gateLabel,
				gateColor: edge.gateColor,
				hasScript: edge.hasScript,
				reverseGateLabel: edge.reverseGateLabel,
				reverseGateColor: edge.reverseGateColor,
				reverseHasScript: edge.reverseHasScript,
				isCyclic: edge.hasCyclic,
				sourceSide: edge.sourceSide,
				targetSide: edge.targetSide,
				id: edge.id,
				runtimeStatus,
			};
		});
	}, [routedSemanticEdges, channels, endpointNodeIdLookup, gates, gateDataMap, runId]);

	// ---- Filter to regular nodes (exclude Task Agent) ----
	const regularNodes = useMemo(
		() =>
			nodes.filter(
				(node) => node.step.id !== TASK_AGENT_NODE_ID && node.step.localId !== TASK_AGENT_NODE_ID
			),
		[nodes]
	);

	// ---- Build WorkflowNodeData[] ----
	const nodeData = useMemo<WorkflowNodeData[]>(() => {
		const startKey =
			workflow?.nodes.find((s) => s.id === workflow.startNodeId)?.id ??
			workflow?.nodes[0]?.id ??
			'';
		const endKey = workflow?.endNodeId
			? (workflow.nodes.find((s) => s.id === workflow.endNodeId)?.id ?? undefined)
			: undefined;

		return regularNodes.map((node, i) => {
			const nodeId = node.step.id;
			const allNodeExecs = nodeId ? (nodeExecutionsByNodeId.get(nodeId) ?? []) : [];
			const nodeExecs = runId
				? allNodeExecs.filter((e) => e.workflowRunId === runId)
				: allNodeExecs;
			const nodeTaskStates: AgentTaskState[] = nodeExecs.map((e) => ({
				agentName: e.agentName ?? null,
				status: e.status,
				completionSummary: e.result,
			}));

			const isStartNode = node.step.localId === startKey || node.step.id === startKey;
			const isEndNode = !!endKey && (node.step.localId === endKey || node.step.id === endKey);

			return {
				stepIndex: i,
				step: node.step,
				position: node.position,
				agents,
				workflowChannels: channels,
				isStartNode,
				isEndNode,
				activeAnchorSides: anchorUsageByNodeId.get(node.step.localId) ?? [],
				nodeTaskStates: nodeTaskStates.length > 0 ? nodeTaskStates : undefined,
			};
		});
	}, [
		regularNodes,
		agents,
		channels,
		workflow,
		nodeExecutionsByNodeId,
		runId,
		anchorUsageByNodeId,
	]);

	// ---- Build canvas node positions ----
	const canvasNodePositions = useMemo<NodePosition>(
		() => buildVisualNodePositions(regularNodes),
		[regularNodes]
	);

	return {
		nodeData,
		channelEdges,
		canvasNodePositions,
		viewportState,
		setViewportState,
		workflow,
		gateDataLoading,
	};
}
