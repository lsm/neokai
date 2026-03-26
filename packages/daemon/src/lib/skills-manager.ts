/**
 * SkillsManager
 *
 * Service layer for the application-level Skills registry.
 * Enforces input validation for security-sensitive fields before persisting.
 */

import { generateUUID } from '@neokai/shared';
import type {
	AppSkill,
	AppSkillConfig,
	CreateSkillParams,
	UpdateSkillParams,
	SkillSourceType,
	SkillValidationStatus,
} from '@neokai/shared';
import type { SkillRepository } from '../storage/repositories/skill-repository';
import type { AppMcpServerRepository } from '../storage/repositories/app-mcp-server-repository';

export class SkillsManager {
	constructor(
		private repo: SkillRepository,
		private appMcpServerRepo: AppMcpServerRepository
	) {}

	listSkills(): AppSkill[] {
		return this.repo.findAll();
	}

	getSkill(id: string): AppSkill | null {
		return this.repo.get(id);
	}

	addSkill(params: CreateSkillParams): AppSkill {
		// Validate sourceType/config consistency and security-sensitive fields
		this.validateSkillConfig(params.sourceType, params.config);

		// Enforce name uniqueness with a user-friendly error
		const existing = this.repo.getByName(params.name);
		if (existing) {
			throw new Error(`A skill named "${params.name}" already exists`);
		}

		const skill: AppSkill = {
			id: generateUUID(),
			name: params.name,
			displayName: params.displayName,
			description: params.description,
			sourceType: params.sourceType,
			config: params.config,
			enabled: params.enabled,
			builtIn: false,
			validationStatus: params.validationStatus ?? 'pending',
			createdAt: Date.now(),
		};

		this.repo.insert(skill);
		const inserted = this.repo.get(skill.id);
		if (!inserted) {
			throw new Error(`Failed to insert skill "${params.name}"`);
		}
		return inserted;
	}

	updateSkill(id: string, params: UpdateSkillParams): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}

		if (params.config !== undefined) {
			this.validateSkillConfig(existing.sourceType, params.config);
		}

		this.repo.update(id, params);
		return this.repo.get(id)!;
	}

	setSkillEnabled(id: string, enabled: boolean): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}
		this.repo.setEnabled(id, enabled);
		return this.repo.get(id)!;
	}

	/**
	 * Set the validation status for a skill (called by the async validation job).
	 * Throws if the skill does not exist so job failures are surfaced, not silenced.
	 */
	setSkillValidationStatus(id: string, status: SkillValidationStatus): AppSkill {
		const existing = this.repo.get(id);
		if (!existing) {
			throw new Error(`Skill not found: ${id}`);
		}
		this.repo.setValidationStatus(id, status);
		return this.repo.get(id)!;
	}

	/**
	 * Remove a skill by ID.
	 * Returns false if the skill is built-in or not found.
	 */
	removeSkill(id: string): boolean {
		const existing = this.repo.get(id);
		if (!existing) return false;
		if (existing.builtIn) return false;
		return this.repo.delete(id);
	}

	getEnabledSkills(): AppSkill[] {
		return this.repo.findEnabled();
	}

	/**
	 * Upsert default built-in skills on startup.
	 * For mcp_server type built-ins, ensures backing app_mcp_servers entries exist.
	 */
	initializeBuiltins(): void {
		// No default built-in skills defined yet — reserved for future use.
		// Implementors: call this.repo.findAll() to check for existing entries,
		// then this.repo.insert() for any that are missing.
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Validate source-type-specific config fields for security.
	 * Throws a descriptive Error on validation failure.
	 *
	 * Checks performed:
	 * 1. sourceType must match config.type (prevents mismatched payloads)
	 * 2. Source-type-specific field constraints
	 */
	private validateSkillConfig(sourceType: SkillSourceType, config: AppSkillConfig): void {
		// Explicit sourceType/config.type consistency check
		if (sourceType !== config.type) {
			throw new Error(`sourceType "${sourceType}" must match config.type "${config.type}"`);
		}

		if (config.type === 'plugin') {
			const { pluginPath } = config;
			if (!pluginPath || pluginPath.trim() === '') {
				throw new Error('plugin skill: pluginPath must not be empty');
			}
			if (!pluginPath.startsWith('/')) {
				throw new Error('plugin skill: pluginPath must be an absolute path (starts with /)');
			}
			// Reject any path that contains '..' as a segment (handles /a/../b and /a/b/..)
			if (pluginPath.split('/').some((seg) => seg === '..')) {
				throw new Error('plugin skill: pluginPath must not contain path traversal sequences (../)');
			}
		} else if (config.type === 'mcp_server') {
			const { appMcpServerId } = config;
			if (!appMcpServerId || appMcpServerId.trim() === '') {
				throw new Error('mcp_server skill: appMcpServerId must not be empty');
			}
			const server = this.appMcpServerRepo.get(appMcpServerId);
			if (!server) {
				throw new Error(
					`mcp_server skill: app_mcp_servers entry not found for id "${appMcpServerId}"`
				);
			}
		} else if (config.type === 'builtin') {
			const { commandName } = config;
			if (!commandName || commandName.trim() === '') {
				throw new Error('builtin skill: commandName must not be empty');
			}
		} else {
			// Exhaustive type guard
			const _exhaustive: never = config;
			throw new Error(`Unknown skill config type: ${(_exhaustive as AppSkillConfig).type}`);
		}
	}
}
