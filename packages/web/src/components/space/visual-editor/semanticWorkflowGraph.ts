import type { Gate, WorkflowChannel } from '@neokai/shared';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import type { VisualNode } from './serialization';
import { getVisualNodeDimensions } from './nodeMetrics';

export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface SemanticWorkflowEdge {
	id: string;
	fromStepId: string;
	toStepId: string;
	direction: 'one-way' | 'bidirectional';
	channelCount: number;
	hasGate: boolean;
	hasCyclic: boolean;
	gateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
	channelIndexes: number[];
}

export interface RoutedSemanticWorkflowEdge extends SemanticWorkflowEdge {
	sourceSide: AnchorSide;
	targetSide: AnchorSide;
}

interface PairAggregate {
	lowId: string;
	highId: string;
	lowToHigh: boolean;
	highToLow: boolean;
	channelCount: number;
	hasGate: boolean;
	hasCyclic: boolean;
	gateType?: 'human' | 'condition' | 'task_result' | 'check' | 'count';
	channelIndexes: Set<number>;
}

function resolveSemanticGateType(
	channel: WorkflowChannel,
	gateLookup: Map<string, Gate>
): SemanticWorkflowEdge['gateType'] {
	if (channel.gateId) {
		const gate = gateLookup.get(channel.gateId);
		if (!gate) return 'check';
		if (gate.condition.type === 'count') return 'count';
		if (gate.condition.type === 'check') {
			const op = gate.condition.op ?? '==';
			if (gate.condition.field === 'approved' && op === '==' && gate.condition.value === true) {
				return 'human';
			}
			if (gate.condition.field === 'result' && op === '==' && typeof gate.condition.value === 'string') {
				return 'task_result';
			}
			return 'check';
		}
		return 'check';
	}

	const gateType = channel.gate?.type;
	if (!gateType || gateType === 'always') return undefined;
	return gateType;
}

function buildEndpointNodeLookup(nodes: VisualNode[]): Map<string, string> {
	const lookup = new Map<string, string>();

	for (const node of nodes) {
		if (node.step.localId === TASK_AGENT_NODE_ID || node.step.id === TASK_AGENT_NODE_ID) continue;

		if (node.step.agentId) {
			lookup.set(node.step.agentId, node.step.localId);
		}

		if (node.step.name) {
			lookup.set(node.step.name, node.step.localId);
		}

		for (const agent of node.step.agents ?? []) {
			if (agent.name) {
				lookup.set(agent.name, node.step.localId);
			}
			if (agent.agentId) {
				lookup.set(agent.agentId, node.step.localId);
			}
		}
	}

	return lookup;
}

export function buildSemanticWorkflowEdges(
	nodes: VisualNode[],
	channels: WorkflowChannel[],
	gates: Gate[] = []
): SemanticWorkflowEdge[] {
	const endpointLookup = buildEndpointNodeLookup(nodes);
	const nodeOrder = new Map(nodes.map((node, index) => [node.step.localId, index]));
	const aggregates = new Map<string, PairAggregate>();
	const gateLookup = new Map(gates.map((gate) => [gate.id, gate]));

	for (const [channelIndex, channel] of channels.entries()) {
		if (channel.from === 'task-agent' || channel.from === '*') continue;

		const fromStepId = endpointLookup.get(channel.from);
		if (!fromStepId) continue;

		const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
		for (const rawTarget of targets) {
			if (rawTarget === 'task-agent' || rawTarget === '*') continue;

			const toStepId = endpointLookup.get(rawTarget);
			if (!toStepId || toStepId === fromStepId) continue;

			const fromOrder = nodeOrder.get(fromStepId) ?? Number.MAX_SAFE_INTEGER;
			const toOrder = nodeOrder.get(toStepId) ?? Number.MAX_SAFE_INTEGER;
			const fromIsLow =
				fromOrder < toOrder || (fromOrder === toOrder && fromStepId.localeCompare(toStepId) <= 0);
			const lowId = fromIsLow ? fromStepId : toStepId;
			const highId = fromIsLow ? toStepId : fromStepId;
			const pairKey = `${lowId}::${highId}`;

			const aggregate = aggregates.get(pairKey) ?? {
				lowId,
				highId,
				lowToHigh: false,
				highToLow: false,
				channelCount: 0,
				hasGate: false,
				hasCyclic: false,
				gateType: undefined,
				channelIndexes: new Set<number>(),
			};

			aggregate.channelCount += 1;
			const gateType = resolveSemanticGateType(channel, gateLookup);
			if (gateType) {
				aggregate.hasGate = true;
				aggregate.gateType ??= gateType;
			}
			if (channel.isCyclic) {
				aggregate.hasCyclic = true;
			}
			aggregate.channelIndexes.add(channelIndex);

			if (channel.direction === 'bidirectional') {
				aggregate.lowToHigh = true;
				aggregate.highToLow = true;
			} else if (fromIsLow) {
				aggregate.lowToHigh = true;
			} else {
				aggregate.highToLow = true;
			}

			aggregates.set(pairKey, aggregate);
		}
	}

	return Array.from(aggregates.values()).map((aggregate) => {
		if (aggregate.lowToHigh && aggregate.highToLow) {
			return {
				id: `${aggregate.lowId}:${aggregate.highId}`,
				fromStepId: aggregate.lowId,
				toStepId: aggregate.highId,
				direction: 'bidirectional',
				channelCount: aggregate.channelCount,
				hasGate: aggregate.hasGate,
				hasCyclic: aggregate.hasCyclic,
				gateType: aggregate.gateType,
				channelIndexes: Array.from(aggregate.channelIndexes),
			};
		}

		if (aggregate.lowToHigh) {
			return {
				id: `${aggregate.lowId}:${aggregate.highId}`,
				fromStepId: aggregate.lowId,
				toStepId: aggregate.highId,
				direction: 'one-way',
				channelCount: aggregate.channelCount,
				hasGate: aggregate.hasGate,
				hasCyclic: aggregate.hasCyclic,
				gateType: aggregate.gateType,
				channelIndexes: Array.from(aggregate.channelIndexes),
			};
		}

		return {
			id: `${aggregate.highId}:${aggregate.lowId}`,
			fromStepId: aggregate.highId,
			toStepId: aggregate.lowId,
			direction: 'one-way',
			channelCount: aggregate.channelCount,
			hasGate: aggregate.hasGate,
			hasCyclic: aggregate.hasCyclic,
			gateType: aggregate.gateType,
			channelIndexes: Array.from(aggregate.channelIndexes),
		};
	});
}

export function routeSemanticWorkflowEdges(
	nodes: VisualNode[],
	semanticEdges: SemanticWorkflowEdge[]
): RoutedSemanticWorkflowEdge[] {
	const positionByNodeId = new Map(
		nodes.map((node) => {
			const { width, height } = getVisualNodeDimensions(node.step);
			return [
				node.step.localId,
				{
					centerX: node.position.x + width / 2,
					centerY: node.position.y + height / 2,
				},
			];
		})
	);

	return semanticEdges.map((edge) => {
		const from = positionByNodeId.get(edge.fromStepId);
		const to = positionByNodeId.get(edge.toStepId);

		if (!from || !to) {
			return {
				...edge,
				sourceSide: 'bottom',
				targetSide: 'top',
			};
		}

		const dx = to.centerX - from.centerX;
		const dy = to.centerY - from.centerY;

		const horizontalDominant = Math.abs(dx) > Math.abs(dy) * 0.85;
		if (horizontalDominant) {
			return {
				...edge,
				sourceSide: dx >= 0 ? 'right' : 'left',
				targetSide: dx >= 0 ? 'left' : 'right',
			};
		}

		return {
			...edge,
			sourceSide: dy >= 0 ? 'bottom' : 'top',
			targetSide: dy >= 0 ? 'top' : 'bottom',
		};
	});
}

export function buildNodeAnchorUsage(
	routedEdges: RoutedSemanticWorkflowEdge[]
): Map<string, AnchorSide[]> {
	const usage = new Map<string, Set<AnchorSide>>();

	for (const edge of routedEdges) {
		const fromSet = usage.get(edge.fromStepId) ?? new Set<AnchorSide>();
		fromSet.add(edge.sourceSide);
		usage.set(edge.fromStepId, fromSet);

		const toSet = usage.get(edge.toStepId) ?? new Set<AnchorSide>();
		toSet.add(edge.targetSide);
		usage.set(edge.toStepId, toSet);
	}

	return new Map(Array.from(usage.entries()).map(([nodeId, sides]) => [nodeId, Array.from(sides)]));
}
