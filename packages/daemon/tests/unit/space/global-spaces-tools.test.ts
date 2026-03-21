/**
 * Unit tests for createGlobalSpacesToolHandlers()
 *
 * Covers autonomy level handling in:
 * - create_space: passes autonomy_level through to SpaceManager
 * - update_space: passes autonomy_level through to SpaceManager
 * - Default behavior when autonomy_level is omitted
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
	createGlobalSpacesToolHandlers,
	type GlobalSpacesToolsConfig,
	type GlobalSpacesState,
} from '../../../src/lib/space/tools/global-spaces-tools';
import type { Space, SpaceAutonomyLevel } from '@neokai/shared';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import type { SpaceRuntime } from '../../../src/lib/space/runtime/space-runtime';
import type { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.now();

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		workspacePath: '/tmp/test-ws',
		name: 'Test Space',
		description: '',
		backgroundContext: '',
		instructions: '',
		sessionIds: [],
		status: 'active',
		autonomyLevel: 'supervised',
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSpaceManager(space: Space): SpaceManager {
	return {
		createSpace: mock(async () => space),
		getSpace: mock(async () => space),
		listSpaces: mock(async () => [space]),
		updateSpace: mock(async () => space),
		archiveSpace: mock(async () => ({ ...space, status: 'archived' as const })),
		deleteSpace: mock(async () => true),
		addSession: mock(async () => space),
		removeSession: mock(async () => space),
	} as unknown as SpaceManager;
}

function makeConfig(spaceManager: SpaceManager): GlobalSpacesToolsConfig {
	return {
		spaceManager,
		spaceAgentManager: {
			listBySpaceId: mock(() => []),
		} as unknown as SpaceAgentManager,
		runtime: {} as unknown as SpaceRuntime,
		workflowManager: {
			listWorkflows: mock(() => []),
		} as unknown as SpaceWorkflowManager,
		taskRepo: {} as unknown as SpaceTaskRepository,
		workflowRunRepo: {} as unknown as SpaceWorkflowRunRepository,
	};
}

function makeState(): GlobalSpacesState {
	return { activeSpaceId: 'space-1' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: { content: Array<{ type: 'text'; text: string }> }) {
	return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('global-spaces-tools: create_space autonomy_level', () => {
	let spaceManager: SpaceManager;
	let handlers: ReturnType<typeof createGlobalSpacesToolHandlers>;

	beforeEach(() => {
		spaceManager = makeSpaceManager(makeSpace({ autonomyLevel: 'supervised' }));
		handlers = createGlobalSpacesToolHandlers(makeConfig(spaceManager), makeState());
	});

	it('passes autonomy_level=supervised to SpaceManager.createSpace', async () => {
		const result = parseResult(
			await handlers.create_space({
				name: 'My Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'supervised',
			})
		);

		expect(result.success).toBe(true);
		expect(spaceManager.createSpace).toHaveBeenCalledTimes(1);
		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('supervised');
	});

	it('passes autonomy_level=semi_autonomous to SpaceManager.createSpace', async () => {
		const semiSpace = makeSpace({ autonomyLevel: 'semi_autonomous' });
		(spaceManager.createSpace as ReturnType<typeof mock>).mockResolvedValue(semiSpace);

		const result = parseResult(
			await handlers.create_space({
				name: 'Semi Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('does not set autonomyLevel when autonomy_level is omitted', async () => {
		await handlers.create_space({ name: 'My Space', workspace_path: '/tmp/ws' });

		const [params] = (spaceManager.createSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBeUndefined();
	});

	it('returns success with the space returned by SpaceManager', async () => {
		const space = makeSpace({ name: 'My Space', autonomyLevel: 'semi_autonomous' });
		(spaceManager.createSpace as ReturnType<typeof mock>).mockResolvedValue(space);

		const result = parseResult(
			await handlers.create_space({
				name: 'My Space',
				workspace_path: '/tmp/ws',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		expect(result.space.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success:false on SpaceManager error', async () => {
		(spaceManager.createSpace as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Workspace path does not exist: /tmp/ws')
		);

		const result = parseResult(
			await handlers.create_space({ name: 'Bad', workspace_path: '/tmp/ws' })
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Workspace path does not exist');
	});
});

describe('global-spaces-tools: update_space autonomy_level', () => {
	let spaceManager: SpaceManager;
	let handlers: ReturnType<typeof createGlobalSpacesToolHandlers>;

	beforeEach(() => {
		spaceManager = makeSpaceManager(makeSpace());
		handlers = createGlobalSpacesToolHandlers(makeConfig(spaceManager), makeState());
	});

	it('passes autonomy_level=semi_autonomous to SpaceManager.updateSpace', async () => {
		const updatedSpace = makeSpace({ autonomyLevel: 'semi_autonomous' });
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updatedSpace);

		const result = parseResult(
			await handlers.update_space({
				space_id: 'space-1',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		const [id, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(id).toBe('space-1');
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('passes autonomy_level=supervised to SpaceManager.updateSpace', async () => {
		await handlers.update_space({ space_id: 'space-1', autonomy_level: 'supervised' });

		const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBe('supervised');
	});

	it('does not set autonomyLevel in params when autonomy_level is omitted', async () => {
		await handlers.update_space({ space_id: 'space-1', name: 'New Name' });

		const [, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(params.autonomyLevel).toBeUndefined();
		expect(params.name).toBe('New Name');
	});

	it('passes all fields including autonomy_level together', async () => {
		await handlers.update_space({
			space_id: 'space-1',
			name: 'Updated',
			description: 'New desc',
			autonomy_level: 'semi_autonomous',
		});

		const [id, params] = (spaceManager.updateSpace as ReturnType<typeof mock>).mock.calls[0];
		expect(id).toBe('space-1');
		expect(params.name).toBe('Updated');
		expect(params.description).toBe('New desc');
		expect(params.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success with space from SpaceManager including updated autonomyLevel', async () => {
		const updatedSpace = makeSpace({ autonomyLevel: 'semi_autonomous' as SpaceAutonomyLevel });
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockResolvedValue(updatedSpace);

		const result = parseResult(
			await handlers.update_space({
				space_id: 'space-1',
				autonomy_level: 'semi_autonomous',
			})
		);

		expect(result.success).toBe(true);
		expect(result.space.autonomyLevel).toBe('semi_autonomous');
	});

	it('returns success:false on SpaceManager error', async () => {
		(spaceManager.updateSpace as ReturnType<typeof mock>).mockRejectedValue(
			new Error('Space not found: bad-id')
		);

		const result = parseResult(
			await handlers.update_space({ space_id: 'bad-id', autonomy_level: 'supervised' })
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Space not found');
	});
});
