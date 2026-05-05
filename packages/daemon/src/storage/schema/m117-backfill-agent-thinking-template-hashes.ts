/**
 * Migration 117 — Backfill preset agent template hashes for thinkingLevel.
 *
 * M116 adds `space_agents.thinking_level`, and the live preset-agent
 * fingerprint now includes `thinkingLevel: null` when no override is set.
 * That intentionally changes the hash shape, but existing preset-tracked rows
 * still carry the pre-M116 hashes stamped by M106/seeding. If left untouched,
 * drift detection reports every previously seeded preset agent as drifted even
 * when the row still matches the user's pre-upgrade state.
 *
 * This migration updates the stored `template_hash` for existing preset-tracked
 * rows by hashing the row's CURRENT fields with the new fingerprint shape. As
 * with M106, hashing row values (not the live preset definition) preserves drift
 * semantics for user-customized rows: customized rows remain customized, but are
 * not falsely marked drifted solely because the fingerprint schema gained a
 * nullable thinking-level field.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { ThinkingLevel } from '@neokai/shared';

const KNOWN_PRESET_NAMES = ['Coder', 'General', 'Planner', 'Research', 'Reviewer', 'QA'] as const;
const THINKING_LEVELS = new Set<string>(['auto', 'think8k', 'think16k', 'think32k']);

interface AgentFingerprintInput {
	name: string;
	description: string;
	tools: string[];
	thinkingLevel?: ThinkingLevel | null;
	customPrompt: string;
}

function buildAgentFingerprint(input: AgentFingerprintInput): {
	name: string;
	description: string;
	tools: string[];
	thinkingLevel: ThinkingLevel | null;
	customPrompt: string;
} {
	return {
		name: (input.name ?? '').trim().toLowerCase(),
		description: input.description ?? '',
		tools: [...(input.tools ?? [])].sort(),
		thinkingLevel: input.thinkingLevel ?? null,
		customPrompt: input.customPrompt ?? '',
	};
}

function hashAgentFingerprint(input: AgentFingerprintInput): string {
	const fp = buildAgentFingerprint(input);
	const json = JSON.stringify(fp);
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(json);
	return hasher.digest('hex');
}

interface AgentRow {
	id: string;
	name: string;
	description: string | null;
	tools: string | null;
	thinking_level: string | null;
	custom_prompt: string | null;
	template_name: string | null;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
		.get(tableName);
	return !!result;
}

function tableHasColumn(db: BunDatabase, tableName: string, columnName: string): boolean {
	const result = db
		.prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
		.get(columnName);
	return !!result;
}

function parseTools(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed.filter((t) => typeof t === 'string') as string[]) : [];
	} catch {
		return [];
	}
}

function parseThinkingLevel(raw: string | null): ThinkingLevel | null {
	return raw && THINKING_LEVELS.has(raw) ? (raw as ThinkingLevel) : null;
}

export function runMigration117(db: BunDatabase): void {
	if (!tableExists(db, 'space_agents')) return;
	if (!tableHasColumn(db, 'space_agents', 'template_name')) return;
	if (!tableHasColumn(db, 'space_agents', 'template_hash')) return;
	if (!tableHasColumn(db, 'space_agents', 'thinking_level')) return;

	const presetByLowerName = new Map<string, string>(
		KNOWN_PRESET_NAMES.map((n) => [n.toLowerCase(), n])
	);

	const rows = db
		.prepare(
			`SELECT id, name, description, tools, thinking_level, custom_prompt, template_name
			   FROM space_agents
			  WHERE template_name IS NOT NULL`
		)
		.all() as AgentRow[];

	if (rows.length === 0) return;

	const update = db.prepare(`UPDATE space_agents SET template_hash = ? WHERE id = ?`);

	for (const row of rows) {
		const canonicalName = presetByLowerName.get((row.template_name ?? '').trim().toLowerCase());
		if (!canonicalName) continue;

		const hash = hashAgentFingerprint({
			name: canonicalName,
			description: row.description ?? '',
			tools: parseTools(row.tools),
			thinkingLevel: parseThinkingLevel(row.thinking_level),
			customPrompt: row.custom_prompt ?? '',
		});

		update.run(hash, row.id);
	}
}
