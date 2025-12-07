/**
 * Claude Model Definitions
 *
 * This file defines all available Claude models with their metadata,
 * aliases, and capabilities.
 */

export interface ModelInfo {
	/** Full model identifier */
	id: string;
	/** Display name for the model */
	name: string;
	/** Short alias for quick reference */
	alias: string;
	/** Model family (opus, sonnet, haiku) */
	family: 'opus' | 'sonnet' | 'haiku';
	/** Context window size in tokens */
	contextWindow: number;
	/** Brief description of the model */
	description: string;
	/** Release date */
	releaseDate: string;
	/** Whether this model is currently available */
	available: boolean;
}

/**
 * Current model information
 * Represents the currently active model in a session
 */
export interface CurrentModelInfo {
	/** Model identifier */
	id: string;
	/** Model metadata (null if model ID is invalid/unknown) */
	info: ModelInfo | null;
}

/**
 * Available Claude models
 * Ordered by family and release date (newest first)
 */
export const CLAUDE_MODELS: ModelInfo[] = [
	// Opus models - Most capable
	{
		id: 'claude-opus-4-20250514',
		name: 'Claude Opus 4',
		alias: 'opus',
		family: 'opus',
		contextWindow: 200000,
		description: 'Most capable model for complex tasks',
		releaseDate: '2025-05-14',
		available: true,
	},
	{
		id: 'claude-opus-4-1-20250805',
		name: 'Claude Opus 4.1',
		alias: 'opus-4.1',
		family: 'opus',
		contextWindow: 200000,
		description: 'Enhanced Opus with improved reasoning',
		releaseDate: '2025-08-05',
		available: true,
	},

	// Sonnet models - Balanced performance
	{
		id: 'claude-sonnet-4-20250514',
		name: 'Claude Sonnet 4',
		alias: 'sonnet-4',
		family: 'sonnet',
		contextWindow: 200000,
		description: 'Balanced model for most use cases',
		releaseDate: '2025-05-14',
		available: true,
	},
	{
		id: 'claude-sonnet-4-5-20241022',
		name: 'Claude Sonnet 4.5',
		alias: 'sonnet',
		family: 'sonnet',
		contextWindow: 200000,
		description: 'Latest Sonnet - recommended for most tasks',
		releaseDate: '2024-10-22',
		available: true,
	},
	{
		id: 'claude-3-5-sonnet-20241022',
		name: 'Claude 3.5 Sonnet',
		alias: 'sonnet-3.5',
		family: 'sonnet',
		contextWindow: 200000,
		description: 'Previous generation Sonnet',
		releaseDate: '2024-10-22',
		available: true,
	},

	// Haiku models - Fast and efficient
	{
		id: 'claude-3-5-haiku-20241022',
		name: 'Claude 3.5 Haiku',
		alias: 'haiku',
		family: 'haiku',
		contextWindow: 200000,
		description: 'Fast, efficient model for quick tasks',
		releaseDate: '2024-10-22',
		available: true,
	},
];

/**
 * Default model to use when none is specified
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20241022';

/**
 * Map of aliases to model IDs for quick lookup
 */
export const MODEL_ALIASES = new Map<string, string>(
	CLAUDE_MODELS.map((model) => [model.alias, model.id])
);

/**
 * Get model info by ID or alias
 */
export function getModelInfo(idOrAlias: string): ModelInfo | undefined {
	// Try exact ID match first
	let model = CLAUDE_MODELS.find((m) => m.id === idOrAlias);

	// Try alias match
	if (!model) {
		const modelId = MODEL_ALIASES.get(idOrAlias);
		if (modelId) {
			model = CLAUDE_MODELS.find((m) => m.id === modelId);
		}
	}

	return model;
}

/**
 * Validate if a model ID or alias is valid
 */
export function isValidModel(idOrAlias: string): boolean {
	return getModelInfo(idOrAlias) !== undefined;
}

/**
 * Resolve a model alias to its full ID
 */
export function resolveModelAlias(idOrAlias: string): string {
	const model = getModelInfo(idOrAlias);
	return model?.id || idOrAlias;
}

/**
 * Get all available models grouped by family
 */
export function getModelsByFamily(): Record<string, ModelInfo[]> {
	return {
		opus: CLAUDE_MODELS.filter((m) => m.family === 'opus' && m.available),
		sonnet: CLAUDE_MODELS.filter((m) => m.family === 'sonnet' && m.available),
		haiku: CLAUDE_MODELS.filter((m) => m.family === 'haiku' && m.available),
	};
}

/**
 * Format model info for display
 */
export function formatModelInfo(model: ModelInfo, includeDescription: boolean = true): string {
	const parts = [
		`${model.name} (${model.alias})`,
		includeDescription ? `- ${model.description}` : '',
	].filter(Boolean);

	return parts.join(' ');
}

/**
 * Get a formatted list of all available models
 */
export function getFormattedModelList(): string {
	const grouped = getModelsByFamily();
	const lines: string[] = [];

	lines.push('Available Claude Models:');
	lines.push('');

	// Opus models
	if (grouped.opus.length > 0) {
		lines.push('🎯 Opus - Most Capable:');
		grouped.opus.forEach((model) => {
			lines.push(`  • ${formatModelInfo(model)}`);
		});
		lines.push('');
	}

	// Sonnet models
	if (grouped.sonnet.length > 0) {
		lines.push('⚡ Sonnet - Balanced:');
		grouped.sonnet.forEach((model) => {
			lines.push(`  • ${formatModelInfo(model)}`);
		});
		lines.push('');
	}

	// Haiku models
	if (grouped.haiku.length > 0) {
		lines.push('🚀 Haiku - Fast & Efficient:');
		grouped.haiku.forEach((model) => {
			lines.push(`  • ${formatModelInfo(model)}`);
		});
	}

	return lines.join('\n');
}
