import { randomUUID } from 'crypto';

export type NeoSecurityMode = 'conservative' | 'balanced' | 'autonomous';
export type ActionRiskLevel = 'low' | 'medium' | 'high';

/**
 * Hardcoded mapping of Neo tool names to risk levels.
 *
 * Low:    toggles, enables/disables, creates, preference updates — easy to reverse
 * Medium: deletes (recoverable), cancels, sends messages, approvals — requires confirmation
 * High:   irreversible deletes with active tasks, bulk ops — must be explicit
 */
export const ActionClassification: Record<string, ActionRiskLevel> = {
	// ── Low risk ──────────────────────────────────────────────────────────────
	toggle_mcp_server: 'low',
	toggle_skill: 'low',
	enable_skill: 'low',
	disable_skill: 'low',
	create_goal: 'low',
	update_goal: 'low',
	update_app_settings: 'low',
	update_room_settings: 'low',
	update_space: 'low',
	create_task: 'low',
	update_task: 'low',
	set_task_status: 'low',
	set_goal_status: 'low',
	pause_schedule: 'low',
	resume_schedule: 'low',

	// ── Medium risk ───────────────────────────────────────────────────────────
	delete_space: 'medium',
	delete_room: 'medium',
	delete_goal: 'medium',
	cancel_workflow_run: 'medium',
	stop_session: 'medium',
	send_message_to_room: 'medium',
	send_message_to_task: 'medium',
	approve_task: 'medium',
	reject_task: 'medium',
	approve_gate: 'medium',
	reject_gate: 'medium',
	add_mcp_server: 'medium',
	update_mcp_server: 'medium',
	delete_mcp_server: 'medium',
	add_skill: 'medium',
	update_skill: 'medium',
	delete_skill: 'medium',

	// ── High risk ─────────────────────────────────────────────────────────────
	delete_room_with_active_tasks: 'high',
	bulk_delete_rooms: 'high',
	bulk_delete_spaces: 'high',
	bulk_cancel_sessions: 'high',
	bulk_delete_goals: 'high',
	undo_last_action: 'high',
};

/**
 * Returns true when the action should be executed without asking the user.
 *
 * Conservative  → nothing auto-executes
 * Balanced      → low auto-executes; medium/high require confirmation
 * Autonomous    → everything auto-executes
 */
export function shouldAutoExecute(mode: NeoSecurityMode, riskLevel: ActionRiskLevel): boolean {
	switch (mode) {
		case 'conservative':
			return false;
		case 'balanced':
			return riskLevel === 'low';
		case 'autonomous':
			return true;
	}
}

/**
 * Returns true when the tool requires an explicit confirmation step before execution.
 * Unknown tools default to 'medium' risk.
 */
export function getConfirmationRequired(mode: NeoSecurityMode, toolName: string): boolean {
	const risk = ActionClassification[toolName] ?? 'medium';
	return !shouldAutoExecute(mode, risk);
}

export type NeoActionResult = {
	success: boolean;
	confirmationRequired?: boolean;
	pendingActionId?: string;
	actionDescription?: string;
	riskLevel?: ActionRiskLevel;
	result?: unknown;
	error?: string;
};

// ── Pending Action Store ──────────────────────────────────────────────────────

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type PendingAction = {
	toolName: string;
	input: Record<string, unknown>;
	createdAt: number;
};

export class PendingActionStore {
	private readonly store = new Map<string, PendingAction>();

	/** Persist an action and return its generated ID. */
	store_action(action: Omit<PendingAction, 'createdAt'>): string {
		const id = randomUUID();
		this.store.set(id, { ...action, createdAt: Date.now() });
		return id;
	}

	/** Retrieve a pending action by ID, returning undefined if expired or missing. */
	retrieve(actionId: string): PendingAction | undefined {
		const action = this.store.get(actionId);
		if (!action) return undefined;
		if (Date.now() - action.createdAt > PENDING_ACTION_TTL_MS) {
			this.store.delete(actionId);
			return undefined;
		}
		return action;
	}

	/** Remove a pending action (after execution or cancellation). */
	remove(actionId: string): void {
		this.store.delete(actionId);
	}

	/** Remove all expired entries. */
	cleanup(): void {
		const now = Date.now();
		for (const [id, action] of this.store) {
			if (now - action.createdAt > PENDING_ACTION_TTL_MS) {
				this.store.delete(id);
			}
		}
	}

	/** Current number of pending actions (including potentially expired ones). */
	get size(): number {
		return this.store.size;
	}
}

// ── Meta-tool definitions ─────────────────────────────────────────────────────

export type ConfirmActionInput = { actionId: string };
export type CancelActionInput = { actionId: string };

/**
 * Builds the confirm_action meta-tool handler bound to a store instance.
 * The executor callback is responsible for actually running the stored tool.
 */
export function makeConfirmActionTool(
	pendingStore: PendingActionStore,
	executor: (toolName: string, input: Record<string, unknown>) => Promise<unknown>
) {
	return async (input: ConfirmActionInput): Promise<NeoActionResult> => {
		const action = pendingStore.retrieve(input.actionId);
		if (!action) {
			return { success: false, error: 'Action not found or expired' };
		}
		pendingStore.remove(input.actionId);
		try {
			const result = await executor(action.toolName, action.input);
			return { success: true, result };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	};
}

/**
 * Builds the cancel_action meta-tool handler bound to a store instance.
 */
export function makeCancelActionTool(pendingStore: PendingActionStore) {
	return (input: CancelActionInput): NeoActionResult => {
		const existed = pendingStore.retrieve(input.actionId) !== undefined;
		pendingStore.remove(input.actionId);
		return {
			success: true,
			actionDescription: existed
				? 'Action cancelled'
				: 'Action not found (may have already expired)',
		};
	};
}
