import { useEffect, useRef } from 'preact/hooks';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkflowNodeData } from './WorkflowCanvas';
import type { Point } from './types';
import type { RoutedSemanticWorkflowEdge } from './semanticWorkflowGraph';
import { ReactFlowWorkflowCanvasRoot } from './ReactFlowWorkflowCanvasRoot';

export interface ReactFlowWorkflowCanvasProps {
	nodes: WorkflowNodeData[];
	semanticEdges: RoutedSemanticWorkflowEdge[];
	selectedNodeId?: string | null;
	onNodeSelect?: (nodeId: string | null) => void;
	onNodePositionChange?: (nodeId: string, position: Point) => void;
}

export function ReactFlowWorkflowCanvas(props: ReactFlowWorkflowCanvasProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<Root | null>(null);

	useEffect(() => {
		if (!hostRef.current) return;
		rootRef.current = createRoot(hostRef.current);

		return () => {
			rootRef.current?.unmount();
			rootRef.current = null;
		};
	}, []);

	useEffect(() => {
		rootRef.current?.render(createElement(ReactFlowWorkflowCanvasRoot, props));
	}, [props]);

	return <div ref={hostRef} class="h-full w-full" data-testid="reactflow-workflow-canvas-host" />;
}
