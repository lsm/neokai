/**
 * SpaceRuntimeService
 *
 * Manages SpaceRuntime lifecycle and provides per-space access to the
 * underlying workflow execution engine.
 *
 * Design: One shared SpaceRuntime handles all spaces in a single tick loop.
 * SpaceRuntimeService provides lifecycle management (start/stop) and a
 * per-space API surface for RPC handlers and DaemonAppContext.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { SpaceManager } from '../managers/space-manager';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import { SpaceRuntime } from './space-runtime';
import { Logger } from '../../logger';

const log = new Logger('space-runtime-service');

export interface SpaceRuntimeServiceConfig {
	db: BunDatabase;
	spaceManager: SpaceManager;
	spaceAgentManager: SpaceAgentManager;
	spaceWorkflowManager: SpaceWorkflowManager;
	workflowRunRepo: SpaceWorkflowRunRepository;
	taskRepo: SpaceTaskRepository;
	tickIntervalMs?: number;
}

export class SpaceRuntimeService {
	private readonly runtime: SpaceRuntime;
	private started = false;

	constructor(private readonly config: SpaceRuntimeServiceConfig) {
		this.runtime = new SpaceRuntime(config);
	}

	/** Start the underlying SpaceRuntime tick loop. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.runtime.start();
		log.info('SpaceRuntimeService started');
	}

	/** Stop the underlying SpaceRuntime tick loop. */
	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.runtime.stop();
		log.info('SpaceRuntimeService stopped');
	}

	/**
	 * Returns the SpaceRuntime for the given space, starting it if needed.
	 *
	 * The underlying runtime is shared — one SpaceRuntime handles all spaces.
	 * This method validates that the space exists and ensures the runtime is
	 * running before returning it.
	 *
	 * Throws if the space does not exist.
	 */
	async createOrGetRuntime(spaceId: string): Promise<SpaceRuntime> {
		const space = await this.config.spaceManager.getSpace(spaceId);
		if (!space) {
			throw new Error(`Space not found: ${spaceId}`);
		}
		if (!this.started) {
			this.start();
		}
		return this.runtime;
	}

	/**
	 * Release the runtime for a given space.
	 *
	 * Currently a no-op — the shared runtime handles all spaces together.
	 * Reserved for future per-space runtime isolation.
	 */
	stopRuntime(_spaceId: string): void {
		// No-op: shared runtime handles all spaces; use stop() to stop entirely.
	}
}
