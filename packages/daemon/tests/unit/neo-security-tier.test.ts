import { describe, expect, it, beforeEach } from 'bun:test';
import {
	type ActionRiskLevel,
	type NeoSecurityMode,
	ActionClassification,
	PendingActionStore,
	getConfirmationRequired,
	makeCancelActionTool,
	makeConfirmActionTool,
	shouldAutoExecute,
} from '../../src/lib/neo/security-tier';

// ── shouldAutoExecute ─────────────────────────────────────────────────────────

describe('shouldAutoExecute', () => {
	const modes: NeoSecurityMode[] = ['conservative', 'balanced', 'autonomous'];
	const levels: ActionRiskLevel[] = ['low', 'medium', 'high'];

	// Full 3×3 matrix
	const matrix: Record<NeoSecurityMode, Record<ActionRiskLevel, boolean>> = {
		conservative: { low: false, medium: false, high: false },
		balanced: { low: true, medium: false, high: false },
		autonomous: { low: true, medium: true, high: true },
	};

	for (const mode of modes) {
		for (const level of levels) {
			it(`${mode} + ${level} → ${matrix[mode][level]}`, () => {
				expect(shouldAutoExecute(mode, level)).toBe(matrix[mode][level]);
			});
		}
	}
});

// ── getConfirmationRequired ───────────────────────────────────────────────────

describe('getConfirmationRequired', () => {
	it('conservative mode always requires confirmation for low risk', () => {
		expect(getConfirmationRequired('conservative', 'toggle_skill')).toBe(true);
	});

	it('conservative mode requires confirmation for high risk', () => {
		expect(getConfirmationRequired('conservative', 'bulk_delete_rooms')).toBe(true);
	});

	it('balanced mode does NOT require confirmation for low risk tool', () => {
		expect(getConfirmationRequired('balanced', 'create_goal')).toBe(false);
	});

	it('balanced mode requires confirmation for medium risk tool', () => {
		expect(getConfirmationRequired('balanced', 'delete_room')).toBe(true);
	});

	it('balanced mode requires confirmation for high risk tool', () => {
		expect(getConfirmationRequired('balanced', 'bulk_delete_rooms')).toBe(true);
	});

	it('autonomous mode never requires confirmation', () => {
		expect(getConfirmationRequired('autonomous', 'bulk_delete_rooms')).toBe(false);
	});

	it('unknown tool defaults to medium risk (confirmed in conservative)', () => {
		expect(getConfirmationRequired('conservative', 'unknown_tool_xyz')).toBe(true);
	});

	it('unknown tool defaults to medium risk (confirmed in balanced)', () => {
		expect(getConfirmationRequired('balanced', 'unknown_tool_xyz')).toBe(true);
	});

	it('unknown tool defaults to medium risk (no confirmation in autonomous)', () => {
		expect(getConfirmationRequired('autonomous', 'unknown_tool_xyz')).toBe(false);
	});
});

// ── ActionClassification ─────────────────────────────────────────────────────

describe('ActionClassification', () => {
	it('toggle_mcp_server is low risk', () => {
		expect(ActionClassification['toggle_mcp_server']).toBe('low');
	});

	it('enable_skill is low risk', () => {
		expect(ActionClassification['enable_skill']).toBe('low');
	});

	it('create_goal is low risk', () => {
		expect(ActionClassification['create_goal']).toBe('low');
	});

	it('update_app_settings is low risk', () => {
		expect(ActionClassification['update_app_settings']).toBe('low');
	});

	it('create_room is low risk', () => {
		expect(ActionClassification['create_room']).toBe('low');
	});

	it('create_space is low risk', () => {
		expect(ActionClassification['create_space']).toBe('low');
	});

	it('start_workflow_run is low risk', () => {
		expect(ActionClassification['start_workflow_run']).toBe('low');
	});

	it('delete_room is medium risk', () => {
		expect(ActionClassification['delete_room']).toBe('medium');
	});

	it('send_message_to_room is medium risk', () => {
		expect(ActionClassification['send_message_to_room']).toBe('medium');
	});

	it('approve_gate is medium risk', () => {
		expect(ActionClassification['approve_gate']).toBe('medium');
	});

	it('bulk_delete_rooms is high risk', () => {
		expect(ActionClassification['bulk_delete_rooms']).toBe('high');
	});

	it('delete_room_with_active_tasks is high risk', () => {
		expect(ActionClassification['delete_room_with_active_tasks']).toBe('high');
	});

	it('all entries are valid risk levels', () => {
		const valid = new Set<string>(['low', 'medium', 'high']);
		for (const [tool, level] of Object.entries(ActionClassification)) {
			expect(valid.has(level), `${tool} has invalid risk level: ${level}`).toBe(true);
		}
	});
});

// ── PendingActionStore ────────────────────────────────────────────────────────

describe('PendingActionStore', () => {
	let store: PendingActionStore;

	beforeEach(() => {
		store = new PendingActionStore();
	});

	it('stores and retrieves a pending action', () => {
		const id = store.store({ toolName: 'delete_room', input: { roomId: 'r1' } });
		const action = store.retrieve(id);
		expect(action).toBeDefined();
		expect(action!.toolName).toBe('delete_room');
		expect(action!.input).toEqual({ roomId: 'r1' });
	});

	it('returns undefined for unknown actionId', () => {
		expect(store.retrieve('non-existent')).toBeUndefined();
	});

	it('remove deletes the action', () => {
		const id = store.store({ toolName: 'toggle_skill', input: {} });
		store.remove(id);
		expect(store.retrieve(id)).toBeUndefined();
	});

	it('cleanup removes expired entries', () => {
		// Manually backdate the stored action by injecting with past createdAt
		const id = store.store({ toolName: 'toggle_skill', input: {} });

		// Tamper with internal state to simulate expiry (cast to any for testing)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const internal = (store as any).map as Map<
			string,
			{ toolName: string; input: unknown; createdAt: number }
		>;
		internal.set(id, {
			toolName: 'toggle_skill',
			input: {},
			createdAt: Date.now() - 6 * 60 * 1000,
		});

		expect(store.size).toBe(1);
		store.cleanup();
		expect(store.size).toBe(0);
	});

	it('retrieve rejects expired action and removes it', () => {
		const id = store.store({ toolName: 'toggle_skill', input: {} });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const internal = (store as any).map as Map<
			string,
			{ toolName: string; input: unknown; createdAt: number }
		>;
		internal.set(id, {
			toolName: 'toggle_skill',
			input: {},
			createdAt: Date.now() - 6 * 60 * 1000,
		});

		expect(store.retrieve(id)).toBeUndefined();
		expect(store.size).toBe(0);
	});

	it('size reflects stored action count', () => {
		expect(store.size).toBe(0);
		store.store({ toolName: 'toggle_skill', input: {} });
		store.store({ toolName: 'delete_room', input: {} });
		expect(store.size).toBe(2);
	});
});

// ── confirm_action meta-tool ──────────────────────────────────────────────────

describe('makeConfirmActionTool', () => {
	let store: PendingActionStore;

	beforeEach(() => {
		store = new PendingActionStore();
	});

	it('executes the stored action and removes it from the store', async () => {
		const id = store.store({
			toolName: 'create_goal',
			input: { roomId: 'r1', title: 'My Goal' },
		});
		const executor = async (_tool: string, input: Record<string, unknown>) => ({
			created: true,
			...input,
		});
		const confirm = makeConfirmActionTool(store, executor);

		const result = await confirm({ actionId: id });
		expect(result.success).toBe(true);
		expect(result.result).toEqual({ created: true, roomId: 'r1', title: 'My Goal' });
		expect(store.retrieve(id)).toBeUndefined();
	});

	it('returns error for unknown or expired actionId', async () => {
		const confirm = makeConfirmActionTool(store, async () => ({}));
		const result = await confirm({ actionId: 'bad-id' });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not found or expired/i);
	});

	it('returns error when executor throws', async () => {
		const id = store.store({ toolName: 'delete_room', input: {} });
		const executor = async () => {
			throw new Error('Permission denied');
		};
		const confirm = makeConfirmActionTool(store, executor);
		const result = await confirm({ actionId: id });
		expect(result.success).toBe(false);
		expect(result.error).toBe('Permission denied');
		// Action should have been removed even on failure
		expect(store.retrieve(id)).toBeUndefined();
	});

	it('passes correct toolName and input to executor', async () => {
		const captured: { toolName: string; input: Record<string, unknown> }[] = [];
		const executor = async (toolName: string, input: Record<string, unknown>) => {
			captured.push({ toolName, input });
			return {};
		};
		const id = store.store({ toolName: 'approve_gate', input: { gateId: 'g42' } });
		const confirm = makeConfirmActionTool(store, executor);
		await confirm({ actionId: id });
		expect(captured).toHaveLength(1);
		expect(captured[0].toolName).toBe('approve_gate');
		expect(captured[0].input).toEqual({ gateId: 'g42' });
	});
});

// ── cancel_action meta-tool ───────────────────────────────────────────────────

describe('makeCancelActionTool', () => {
	let store: PendingActionStore;

	beforeEach(() => {
		store = new PendingActionStore();
	});

	it('removes a pending action and returns success', () => {
		const id = store.store({ toolName: 'delete_room', input: {} });
		const cancel = makeCancelActionTool(store);
		const result = cancel({ actionId: id });
		expect(result.success).toBe(true);
		expect(store.retrieve(id)).toBeUndefined();
	});

	it('returns success with a note when action does not exist', () => {
		const cancel = makeCancelActionTool(store);
		const result = cancel({ actionId: 'ghost-id' });
		expect(result.success).toBe(true);
		expect(result.actionDescription).toMatch(/not found/i);
	});
});
