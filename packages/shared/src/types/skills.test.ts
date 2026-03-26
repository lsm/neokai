import { describe, expect, it } from 'bun:test';
import type {
	AppSkill,
	AppSkillConfig,
	BuiltinSkillConfig,
	CreateSkillParams,
	McpServerSkillConfig,
	PluginSkillConfig,
	SkillSourceType,
	SkillValidationStatus,
	UpdateSkillParams,
} from './skills.ts';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isBuiltinSkillConfig(config: AppSkillConfig): config is BuiltinSkillConfig {
	return 'commandName' in config;
}

function isPluginSkillConfig(config: AppSkillConfig): config is PluginSkillConfig {
	return 'pluginPath' in config;
}

function isMcpServerSkillConfig(config: AppSkillConfig): config is McpServerSkillConfig {
	return 'appMcpServerId' in config;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const builtinConfig: BuiltinSkillConfig = { commandName: 'update-config' };
const pluginConfig: PluginSkillConfig = { pluginPath: '/home/user/.neokai/skills/my-skill' };
const mcpConfig: McpServerSkillConfig = { appMcpServerId: 'mcp-uuid-1234' };

const baseSkill: AppSkill = {
	id: 'skill-uuid-1',
	name: 'web-search',
	displayName: 'Web Search',
	description: 'Searches the web using Brave API',
	sourceType: 'mcp_server',
	config: mcpConfig,
	enabled: true,
	builtIn: false,
	validationStatus: 'valid',
	createdAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillSourceType', () => {
	it('accepts valid source types', () => {
		const types: SkillSourceType[] = ['builtin', 'plugin', 'mcp_server'];
		expect(types).toHaveLength(3);
	});
});

describe('SkillValidationStatus', () => {
	it('accepts all valid statuses', () => {
		const statuses: SkillValidationStatus[] = ['pending', 'valid', 'invalid', 'unknown'];
		expect(statuses).toHaveLength(4);
	});
});

describe('AppSkillConfig discriminated union', () => {
	it('identifies BuiltinSkillConfig correctly', () => {
		const config: AppSkillConfig = builtinConfig;
		expect(isBuiltinSkillConfig(config)).toBe(true);
		expect(isPluginSkillConfig(config)).toBe(false);
		expect(isMcpServerSkillConfig(config)).toBe(false);
	});

	it('identifies PluginSkillConfig correctly', () => {
		const config: AppSkillConfig = pluginConfig;
		expect(isBuiltinSkillConfig(config)).toBe(false);
		expect(isPluginSkillConfig(config)).toBe(true);
		expect(isMcpServerSkillConfig(config)).toBe(false);
	});

	it('identifies McpServerSkillConfig correctly', () => {
		const config: AppSkillConfig = mcpConfig;
		expect(isBuiltinSkillConfig(config)).toBe(false);
		expect(isPluginSkillConfig(config)).toBe(false);
		expect(isMcpServerSkillConfig(config)).toBe(true);
	});
});

describe('AppSkill', () => {
	it('has all required fields', () => {
		expect(baseSkill.id).toBe('skill-uuid-1');
		expect(baseSkill.name).toBe('web-search');
		expect(baseSkill.displayName).toBe('Web Search');
		expect(baseSkill.description).toBeTruthy();
		expect(baseSkill.sourceType).toBe('mcp_server');
		expect(baseSkill.enabled).toBe(true);
		expect(baseSkill.builtIn).toBe(false);
		expect(baseSkill.validationStatus).toBe('valid');
		expect(baseSkill.createdAt).toBeTruthy();
	});

	it('config is accessible as McpServerSkillConfig when sourceType is mcp_server', () => {
		if (isMcpServerSkillConfig(baseSkill.config)) {
			expect(baseSkill.config.appMcpServerId).toBe('mcp-uuid-1234');
		} else {
			throw new Error('Expected McpServerSkillConfig');
		}
	});

	it('supports builtin sourceType with BuiltinSkillConfig', () => {
		const skill: AppSkill = {
			...baseSkill,
			id: 'skill-builtin-1',
			sourceType: 'builtin',
			config: builtinConfig,
			builtIn: true,
		};
		expect(skill.sourceType).toBe('builtin');
		if (isBuiltinSkillConfig(skill.config)) {
			expect(skill.config.commandName).toBe('update-config');
		} else {
			throw new Error('Expected BuiltinSkillConfig');
		}
	});

	it('supports plugin sourceType with PluginSkillConfig', () => {
		const skill: AppSkill = {
			...baseSkill,
			id: 'skill-plugin-1',
			sourceType: 'plugin',
			config: pluginConfig,
		};
		expect(skill.sourceType).toBe('plugin');
		if (isPluginSkillConfig(skill.config)) {
			expect(skill.config.pluginPath).toBe('/home/user/.neokai/skills/my-skill');
		} else {
			throw new Error('Expected PluginSkillConfig');
		}
	});
});

describe('CreateSkillParams', () => {
	it('excludes id, createdAt, builtIn', () => {
		const params: CreateSkillParams = {
			name: 'my-skill',
			displayName: 'My Skill',
			description: 'Does something useful',
			sourceType: 'plugin',
			config: pluginConfig,
			enabled: true,
			validationStatus: 'pending',
		};
		// TypeScript would error if id/createdAt/builtIn were required — verify shape at runtime
		expect('id' in params).toBe(false);
		expect('createdAt' in params).toBe(false);
		expect('builtIn' in params).toBe(false);
		expect(params.name).toBe('my-skill');
	});
});

describe('UpdateSkillParams', () => {
	it('allows partial updates', () => {
		const patch: UpdateSkillParams = { enabled: false };
		expect(patch.enabled).toBe(false);
	});

	it('allows empty update object', () => {
		const patch: UpdateSkillParams = {};
		expect(Object.keys(patch)).toHaveLength(0);
	});

	it('allows updating multiple fields', () => {
		const patch: UpdateSkillParams = {
			displayName: 'Updated Name',
			validationStatus: 'invalid',
			enabled: false,
		};
		expect(patch.displayName).toBe('Updated Name');
		expect(patch.validationStatus).toBe('invalid');
		expect(patch.enabled).toBe(false);
	});
});
