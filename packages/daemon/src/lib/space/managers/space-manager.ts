/**
 * SpaceManager - Space management with workspace path validation
 *
 * Handles:
 * - Creating spaces with workspace path validation (symlink resolution, existence check, uniqueness)
 * - Listing, updating, archiving, and deleting spaces
 * - Session association
 */

import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database as BunDatabase } from 'bun:sqlite';
import { SpaceRepository } from '../../../storage/repositories/space-repository';
import { Logger } from '../../logger';
import type { Space, CreateSpaceParams, UpdateSpaceParams } from '@neokai/shared';

const execAsync = promisify(exec);
const log = new Logger('SpaceManager');

export class SpaceManager {
	private spaceRepo: SpaceRepository;

	constructor(private db: BunDatabase) {
		this.spaceRepo = new SpaceRepository(db);
	}

	/**
	 * Create a new space.
	 * Validates the workspace path: resolves symlinks, checks existence, ensures uniqueness.
	 * Warns (but does not fail) if the path is not a git repository.
	 */
	async createSpace(params: CreateSpaceParams): Promise<Space> {
		const resolvedPath = await this.resolveAndValidatePath(params.workspacePath);

		// Check uniqueness across active spaces
		const existing = this.spaceRepo.getSpaceByPath(resolvedPath);
		if (existing) {
			throw new Error(
				`A space already exists for workspace path: ${resolvedPath} (space id: ${existing.id})`
			);
		}

		// Warn if not a git repository (non-fatal)
		const isGit = await this.isGitRepository(resolvedPath);
		if (!isGit) {
			log.warn(`workspace path is not a git repository: ${resolvedPath}`);
		}

		return this.spaceRepo.createSpace({ ...params, workspacePath: resolvedPath });
	}

	/**
	 * Get a space by ID
	 */
	async getSpace(id: string): Promise<Space | null> {
		return this.spaceRepo.getSpace(id);
	}

	/**
	 * List spaces
	 */
	async listSpaces(includeArchived = false): Promise<Space[]> {
		return this.spaceRepo.listSpaces(includeArchived);
	}

	/**
	 * Update a space
	 */
	async updateSpace(id: string, params: UpdateSpaceParams): Promise<Space> {
		const space = this.spaceRepo.getSpace(id);
		if (!space) {
			throw new Error(`Space not found: ${id}`);
		}

		const updated = this.spaceRepo.updateSpace(id, params);
		if (!updated) {
			throw new Error(`Failed to update space: ${id}`);
		}

		return updated;
	}

	/**
	 * Archive a space
	 */
	async archiveSpace(id: string): Promise<Space> {
		const space = this.spaceRepo.getSpace(id);
		if (!space) {
			throw new Error(`Space not found: ${id}`);
		}

		const archived = this.spaceRepo.archiveSpace(id);
		if (!archived) {
			throw new Error(`Failed to archive space: ${id}`);
		}

		return archived;
	}

	/**
	 * Delete a space by ID
	 */
	async deleteSpace(id: string): Promise<boolean> {
		const space = this.spaceRepo.getSpace(id);
		if (!space) {
			return false;
		}

		return this.spaceRepo.deleteSpace(id);
	}

	/**
	 * Add a session to a space
	 */
	async addSession(spaceId: string, sessionId: string): Promise<Space> {
		const updated = this.spaceRepo.addSessionToSpace(spaceId, sessionId);
		if (!updated) {
			throw new Error(`Space not found: ${spaceId}`);
		}
		return updated;
	}

	/**
	 * Remove a session from a space
	 */
	async removeSession(spaceId: string, sessionId: string): Promise<Space> {
		const updated = this.spaceRepo.removeSessionFromSpace(spaceId, sessionId);
		if (!updated) {
			throw new Error(`Space not found: ${spaceId}`);
		}
		return updated;
	}

	/**
	 * Resolve symlinks and validate the workspace path exists and is a directory.
	 * Returns the real (resolved) absolute path.
	 */
	private async resolveAndValidatePath(workspacePath: string): Promise<string> {
		// Resolve symlinks to get the canonical real path
		let realPath: string;
		try {
			realPath = await fs.realpath(workspacePath);
		} catch {
			throw new Error(`Workspace path does not exist: ${workspacePath}`);
		}

		// Verify it is accessible and is a directory
		try {
			const stat = await fs.stat(realPath);
			if (!stat.isDirectory()) {
				throw new Error(`Workspace path is not a directory: ${realPath}`);
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes('not a directory')) {
				throw err;
			}
			throw new Error(`Cannot access workspace path: ${realPath}`);
		}

		return realPath;
	}

	/**
	 * Check if the given path is inside a git repository (non-fatal check)
	 */
	private async isGitRepository(dirPath: string): Promise<boolean> {
		try {
			await execAsync('git rev-parse --git-dir', { cwd: dirPath });
			return true;
		} catch {
			return false;
		}
	}
}
