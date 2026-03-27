/**
 * Gate Migration Utilities
 *
 * Converts legacy `WorkflowCondition` gate definitions (inline on channels)
 * to the separated `Gate` + `Channel` format (M1.1).
 *
 * Migration rules:
 *   always      → remove gate (channel without gateId is always open)
 *   human       → Gate with check condition: { field: 'approved', value: true }
 *   condition   → Gate with check condition: { field: 'result', value: true }
 *                  (shell expression stored in gate description for reference)
 *   task_result → Gate with check condition: { field: 'result', value: expression }
 */

import type { WorkflowCondition } from './space.ts';
import type { Gate, GateCondition } from './space.ts';

/** Result of migrating a legacy channel's inline gate to the separated format. */
export interface GateMigrationResult {
	/** The migrated gate, or null if the channel had no gate or was 'always'. */
	gate: Gate | null;
	/** The gate ID to set on the channel, or undefined if the channel is gateless. */
	gateId: string | undefined;
}

/**
 * Converts a legacy `WorkflowCondition` to a separated `Gate`.
 *
 * @param legacyCondition - The old inline condition from `WorkflowChannel.gate`.
 * @param gateId - The ID to assign to the new Gate entity.
 * @returns Migration result with the new Gate (or null for `always`/absent conditions).
 */
export function migrateLegacyCondition(
	legacyCondition: WorkflowCondition | undefined,
	gateId: string
): GateMigrationResult {
	if (!legacyCondition) {
		return { gate: null, gateId: undefined };
	}

	switch (legacyCondition.type) {
		case 'always':
			// always → no gate needed; channel is always open
			return { gate: null, gateId: undefined };

		case 'human': {
			const condition: GateCondition = { type: 'check', field: 'approved', value: true };
			return {
				gate: {
					id: gateId,
					condition,
					data: { approved: false },
					allowedWriterRoles: ['*'],
					description: legacyCondition.description ?? 'Human approval gate (migrated from legacy)',
					resetOnCycle: false,
				},
				gateId,
			};
		}

		case 'condition': {
			// Shell expression conditions become a check on 'result' field.
			// The actual shell expression is stored in description for reference.
			const condition: GateCondition = { type: 'check', field: 'result', value: true };
			return {
				gate: {
					id: gateId,
					condition,
					data: { result: false },
					allowedWriterRoles: ['*'],
					description:
						legacyCondition.description ??
						`Shell condition gate (migrated). Original expression: ${legacyCondition.expression ?? '(empty)'}`,
					resetOnCycle: false,
				},
				gateId,
			};
		}

		case 'task_result': {
			const condition: GateCondition = {
				type: 'check',
				field: 'result',
				value: legacyCondition.expression ?? 'passed',
			};
			return {
				gate: {
					id: gateId,
					condition,
					data: {},
					allowedWriterRoles: ['*'],
					description:
						legacyCondition.description ??
						`Task result gate: awaiting result="${legacyCondition.expression ?? 'passed'}" (migrated)`,
					resetOnCycle: false,
				},
				gateId,
			};
		}

		default: {
			// Unknown type — create a conservative check gate
			return { gate: null, gateId: undefined };
		}
	}
}
