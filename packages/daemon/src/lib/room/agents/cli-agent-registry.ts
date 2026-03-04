/**
 * CLI Agent Registry
 *
 * Detects available CLI-based AI agents on the system at startup.
 * Checks if known CLI tools are installed and accessible on $PATH.
 *
 * Results are cached in memory and exposed via RPC for the frontend.
 */

import { execSync } from 'node:child_process';
import { Logger } from '../../logger';

const log = new Logger('cli-agent-registry');

export interface CliAgentInfo {
	/** Unique identifier for this CLI agent (e.g., 'codex', 'codex:gpt-5.3-codex') */
	id: string;
	/** Human-readable name */
	name: string;
	/** The CLI command to invoke */
	command: string;
	/** Provider/vendor name */
	provider: string;
	/** Whether the CLI binary was found on PATH */
	installed: boolean;
	/** Whether the agent appears to be authenticated */
	authenticated: boolean;
	/** Resolved path to the binary (if installed) */
	path?: string;
	/** Version string (if detectable) */
	version?: string;
	/** Model IDs available through this CLI agent */
	models?: string[];
}

interface CliAgentDefinition {
	id: string;
	name: string;
	command: string;
	provider: string;
	/** Command to check version (default: `<command> --version`) */
	versionCommand?: string;
	/** Command to check auth status (should exit 0 if authenticated) */
	authCheckCommand?: string;
	/** Known model IDs for this CLI agent */
	knownModels?: string[];
	/** Command to list available models (output parsed as one model per line) */
	modelsCommand?: string;
}

const KNOWN_CLI_AGENTS: CliAgentDefinition[] = [
	{
		id: 'codex',
		name: 'Codex',
		command: 'codex',
		provider: 'OpenAI',
		knownModels: ['gpt-5.3-codex', 'o3', 'o4-mini', 'gpt-4.1'],
	},
	{
		id: 'gemini',
		name: 'Gemini CLI',
		command: 'gemini',
		provider: 'Google',
		knownModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
	},
	{
		id: 'aider',
		name: 'Aider',
		command: 'aider',
		provider: 'Aider',
	},
	{
		id: 'copilot',
		name: 'GitHub Copilot CLI',
		command: 'gh',
		provider: 'GitHub',
		versionCommand: 'gh copilot --help',
		authCheckCommand: 'gh auth status',
	},
];

function runCommand(cmd: string, timeoutMs = 5000): { ok: boolean; output: string } {
	try {
		const output = execSync(cmd, {
			timeout: timeoutMs,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
		return { ok: true, output };
	} catch {
		return { ok: false, output: '' };
	}
}

function detectAgent(def: CliAgentDefinition): CliAgentInfo {
	const info: CliAgentInfo = {
		id: def.id,
		name: def.name,
		command: def.command,
		provider: def.provider,
		installed: false,
		authenticated: false,
	};

	// Check if binary exists on PATH
	const which = runCommand(`which ${def.command}`);
	if (!which.ok) {
		return info;
	}

	info.installed = true;
	info.path = which.output;

	// Try to get version
	const versionCmd = def.versionCommand ?? `${def.command} --version`;
	const version = runCommand(versionCmd);
	if (version.ok && version.output) {
		// Extract first line, trim to reasonable length
		info.version = version.output.split('\n')[0].slice(0, 100);
	}

	// Check auth status
	if (def.authCheckCommand) {
		const auth = runCommand(def.authCheckCommand);
		info.authenticated = auth.ok;
	} else {
		// If no explicit auth check, assume authenticated if installed
		info.authenticated = true;
	}

	// Detect available models
	if (def.modelsCommand) {
		const modelsResult = runCommand(def.modelsCommand);
		if (modelsResult.ok && modelsResult.output) {
			info.models = modelsResult.output
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
		}
	}
	if (!info.models && def.knownModels) {
		info.models = def.knownModels;
	}

	return info;
}

/** Singleton registry of detected CLI agents */
let cachedAgents: CliAgentInfo[] | null = null;

/**
 * Detect all known CLI agents. Results are cached after first call.
 * Call refresh() to re-detect.
 */
export function getCliAgents(): CliAgentInfo[] {
	if (cachedAgents) return cachedAgents;
	return refresh();
}

/**
 * Re-detect all CLI agents and update the cache.
 */
export function refresh(): CliAgentInfo[] {
	log.info('Detecting CLI agents...');
	cachedAgents = KNOWN_CLI_AGENTS.map((def) => {
		const info = detectAgent(def);
		if (info.installed) {
			log.info(
				`  ${info.name}: installed (${info.version ?? 'unknown version'}), auth=${info.authenticated}`
			);
		} else {
			log.info(`  ${info.name}: not installed`);
		}
		return info;
	});
	return cachedAgents;
}
