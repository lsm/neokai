/** @jsxImportSource react */

import '@xyflow/react/dist/style.css';

import * as React from 'react';
import {
	Background,
	BaseEdge,
	Controls,
	Handle,
	MarkerType,
	Position,
	ReactFlow,
	ReactFlowProvider,
	getSmoothStepPath,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Edge,
	type EdgeProps,
	type Node,
	type NodeMouseHandler,
	type NodeProps,
} from '@xyflow/react';
import { TASK_AGENT_NODE_ID } from '@neokai/shared';
import { isMultiAgentNode } from '../WorkflowNodeCard';
import type { WorkflowNodeData } from './WorkflowCanvas';
import type { Point } from './types';
import type { AnchorSide, RoutedSemanticWorkflowEdge } from './semanticWorkflowGraph';

interface WorkflowReactNodeData extends Record<string, unknown> {
	stepIndex: number;
	stepName: string;
	agentName: string;
	agentSlots?: string[];
	isStartNode: boolean;
	isTaskAgent: boolean;
	activeAnchorSides?: AnchorSide[];
}

interface SemanticReactEdgeData extends Record<string, unknown> {
	channelCount: number;
}

export interface ReactFlowWorkflowCanvasRootProps {
	nodes: WorkflowNodeData[];
	semanticEdges: RoutedSemanticWorkflowEdge[];
	selectedNodeId?: string | null;
	onNodeSelect?: (nodeId: string | null) => void;
	onNodePositionChange?: (nodeId: string, position: Point) => void;
}

function dockClass(active: boolean) {
	return active
		? '!opacity-100 !border-gray-700 !bg-gray-500'
		: '!opacity-0 group-hover:!opacity-100 !border-gray-700 !bg-gray-500';
}

function sideDockStyle(side: AnchorSide): React.CSSProperties {
	switch (side) {
		case 'top':
			return { left: '50%', top: -7, transform: 'translateX(-50%)' };
		case 'bottom':
			return { left: '50%', bottom: -7, transform: 'translateX(-50%)' };
		case 'left':
			return { left: -7, top: '50%', transform: 'translateY(-50%)' };
		case 'right':
			return { right: -7, top: '50%', transform: 'translateY(-50%)' };
	}
}

function renderPassiveDock(side: AnchorSide) {
	return (
		<div
			key={`dock-${side}`}
			className="pointer-events-none absolute h-3 w-3 rounded-full border-2 border-gray-700 bg-gray-500"
			style={sideDockStyle(side)}
		/>
	);
}

function WorkflowReactNode({ data: rawData, selected }: NodeProps) {
	const data = rawData as WorkflowReactNodeData;
	const borderClass = data.isTaskAgent
		? 'border-amber-400'
		: data.isStartNode
			? 'border-green-500'
			: selected
				? 'border-blue-500'
				: 'border-gray-700';

	const bgClass = data.isTaskAgent ? 'bg-amber-950' : 'bg-gray-800';
	const activeAnchorSides = new Set(data.activeAnchorSides ?? []);

	return (
		<div
			className={`group rounded-lg border-2 ${borderClass} ${bgClass} shadow-[0_8px_24px_rgba(0,0,0,0.28)] min-w-[160px] ${data.agentSlots?.length ? 'max-w-[220px]' : ''}`}
		>
			{!data.isTaskAgent && (data.activeAnchorSides ?? []).map((side) => renderPassiveDock(side))}

			{!data.isTaskAgent &&
				(['top', 'bottom', 'left', 'right'] as AnchorSide[]).map((side) => (
					<Handle
						key={`target-${side}`}
						id={side}
						type="target"
						position={
							side === 'top'
								? Position.Top
								: side === 'bottom'
									? Position.Bottom
									: side === 'left'
										? Position.Left
										: Position.Right
						}
						isConnectable={false}
						style={sideDockStyle(side)}
						className={`!w-3 !h-3 !rounded-full !border-2 !transition-opacity ${dockClass(false)}`}
					/>
				))}

			<div className="px-3 py-2">
				{data.isTaskAgent ? (
					<>
						<div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
							Task Agent
						</div>
						<div className="text-sm font-medium text-amber-100">{data.stepName}</div>
					</>
				) : (
					<>
						<div className="mb-1 flex items-center justify-between gap-2">
							<span className="rounded bg-gray-700 px-1.5 py-0.5 text-xs font-mono text-gray-300">
								{data.stepIndex + 1}
							</span>
							{data.isStartNode && (
								<span className="text-[10px] font-bold uppercase tracking-[0.18em] text-green-400">
									START
								</span>
							)}
						</div>
						<div className="text-sm font-medium text-white">{data.stepName}</div>
						{data.agentSlots && data.agentSlots.length > 0 ? (
							<div className="mt-1 flex flex-wrap gap-1">
								{data.agentSlots.map((slot) => (
									<span
										key={slot}
										className="rounded bg-gray-700 px-1.5 py-0.5 text-[11px] text-gray-300"
									>
										{slot}
									</span>
								))}
							</div>
						) : (
							<div className="mt-0.5 text-xs text-gray-400">{data.agentName}</div>
						)}
					</>
				)}
			</div>

			{!data.isTaskAgent && (
				<>
					{(['top', 'bottom', 'left', 'right'] as AnchorSide[]).map((side) => (
						<Handle
							key={`source-${side}`}
							id={side}
							type="source"
							position={
								side === 'top'
									? Position.Top
									: side === 'bottom'
										? Position.Bottom
										: side === 'left'
											? Position.Left
											: Position.Right
							}
							isConnectable={false}
							style={sideDockStyle(side)}
							className={`!w-3 !h-3 !rounded-full !border-2 !transition-opacity ${dockClass(false)}`}
						/>
					))}
				</>
			)}
		</div>
	);
}

function SemanticReactEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	selected,
	data,
	markerStart,
	markerEnd,
}: EdgeProps) {
	const edgeData = data as SemanticReactEdgeData | undefined;
	const [path, labelX, labelY] = getSmoothStepPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		borderRadius: 24,
		offset: 28,
	});

	const stroke = selected ? '#ffffff' : '#39c6bb';

	return (
		<>
			<BaseEdge
				id={id}
				path={path}
				style={{
					stroke,
					strokeWidth: selected ? 2.8 : 2,
					opacity: selected ? 1 : 0.92,
				}}
				markerStart={markerStart}
				markerEnd={markerEnd}
			/>
			{(edgeData?.channelCount ?? 0) > 1 && (
				<foreignObject x={labelX - 16} y={labelY - 10} width={32} height={20}>
					<div className="flex h-5 w-8 items-center justify-center rounded-full border border-dark-500 bg-dark-900/95 text-[10px] font-medium text-teal-200">
						{edgeData?.channelCount}
					</div>
				</foreignObject>
			)}
		</>
	);
}

const nodeTypes = {
	workflowNode: WorkflowReactNode,
};

const edgeTypes = {
	semantic: SemanticReactEdge,
};

function ReactFlowWorkflowCanvasInner({
	nodes,
	semanticEdges,
	selectedNodeId,
	onNodeSelect,
	onNodePositionChange,
}: ReactFlowWorkflowCanvasRootProps) {
	const reactFlow = useReactFlow();

	const flowNodes = React.useMemo<Node[]>(() => {
		return nodes.map((node) => ({
			id: node.step.localId,
			type: 'workflowNode',
			position: node.position,
			selected: selectedNodeId === node.step.localId,
			data: {
				stepIndex: node.stepIndex,
				stepName: node.step.name || (node.step.localId === TASK_AGENT_NODE_ID ? 'Task Agent' : '(unnamed)'),
				agentName:
					node.step.localId === TASK_AGENT_NODE_ID
						? 'Task Agent'
						: node.agents.find((agent) => agent.id === node.step.agentId)?.name ?? node.step.agentId,
				agentSlots: isMultiAgentNode(node.step) ? node.step.agents?.map((slot) => slot.name) : undefined,
				isStartNode: !!node.isStartNode,
				isTaskAgent: node.step.localId === TASK_AGENT_NODE_ID,
				activeAnchorSides: node.activeAnchorSides ?? [],
			},
			draggable: node.step.localId !== TASK_AGENT_NODE_ID,
			selectable: true,
		}));
	}, [nodes, selectedNodeId]);

	const flowEdges = React.useMemo<Edge[]>(() => {
		return semanticEdges.map((edge) => ({
			id: edge.id,
			source: edge.fromStepId,
			target: edge.toStepId,
			type: 'semantic',
			sourceHandle: edge.sourceSide,
			targetHandle: edge.targetSide,
			data: {
				channelCount: edge.channelCount,
			},
			markerEnd: {
				type: MarkerType.ArrowClosed,
				color: '#39c6bb',
				width: 18,
				height: 18,
			},
			markerStart:
				edge.direction === 'bidirectional'
					? {
							type: MarkerType.ArrowClosed,
							color: '#39c6bb',
							width: 18,
							height: 18,
						}
					: undefined,
			selectable: false,
		}));
	}, [semanticEdges]);

	const fitSignature = React.useMemo(
		() =>
			`${nodes.map((node) => node.step.localId).join('|')}::${semanticEdges.map((edge) => edge.id).join('|')}`,
		[nodes, semanticEdges]
	);

	const [rfNodes, setRfNodes, onNodesChange] = useNodesState(flowNodes);
	const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(flowEdges);

	React.useEffect(() => {
		setRfNodes(flowNodes);
	}, [flowNodes, setRfNodes]);

	React.useEffect(() => {
		setRfEdges(flowEdges);
	}, [flowEdges, setRfEdges]);

	React.useEffect(() => {
		queueMicrotask(() => {
			reactFlow.fitView({
				padding: 0.18,
				includeHiddenNodes: true,
				duration: 180,
				nodes: flowNodes.map((node: Node) => ({ id: node.id })),
			});
		});
	}, [fitSignature, flowNodes, reactFlow]);

	const handleNodeClick = React.useCallback<NodeMouseHandler>(
		(_event, node) => onNodeSelect?.(node.id),
		[onNodeSelect]
	);

	const handleNodeDragStop = React.useCallback<NodeMouseHandler>(
		(_event, node) => {
			onNodePositionChange?.(node.id, { x: node.position.x, y: node.position.y });
		},
		[onNodePositionChange]
	);

	return (
		<ReactFlow
			nodes={rfNodes}
			edges={rfEdges}
			nodeTypes={nodeTypes}
			edgeTypes={edgeTypes}
			onNodesChange={onNodesChange}
			onEdgesChange={onEdgesChange}
			colorMode="dark"
			minZoom={0.25}
			maxZoom={2}
			nodesConnectable={false}
			elementsSelectable
			proOptions={{ hideAttribution: true }}
			defaultEdgeOptions={{
				type: 'semantic',
			}}
			onNodeClick={handleNodeClick}
			onPaneClick={() => onNodeSelect?.(null)}
			onNodeDragStop={handleNodeDragStop}
			className="bg-dark-950"
		>
			<Background color="#1f2937" gap={24} size={1} />
			<Controls showInteractive={false} className="!rounded-lg !border !border-dark-700 !bg-dark-850 !shadow-lg" />
		</ReactFlow>
	);
}

export function ReactFlowWorkflowCanvasRoot(props: ReactFlowWorkflowCanvasRootProps) {
	return (
		<div className="h-full w-full overflow-hidden bg-dark-950">
			<ReactFlowProvider>
				<ReactFlowWorkflowCanvasInner {...props} />
			</ReactFlowProvider>
		</div>
	);
}
