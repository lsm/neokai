/**
 * Legacy workflow condition types.
 *
 * These types were removed from @neokai/shared when the inline `channel.gate`
 * field was replaced by the separated Gate architecture (`gateId` + `gates[]`).
 *
 * They are kept locally because the visual editor still uses them for:
 * - Step transition edges (VisualTransition, VisualEdge)
 * - Edge color coding in EdgeRenderer
 * - Condition UI in EdgeConfigPanel and GateConfig
 *
 * These are purely UI-side types and do NOT correspond to any backend schema.
 */

export type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';

export interface WorkflowCondition {
	type: WorkflowConditionType;
	expression?: string;
	description?: string;
	maxRetries?: number;
	timeoutMs?: number;
}
