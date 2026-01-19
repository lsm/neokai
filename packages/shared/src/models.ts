/**
 * Model Type Definitions
 *
 * This file defines the types for model information.
 * The actual model list is fetched dynamically from the SDK via supportedModels().
 * GLM models are defined statically as they use an Anthropic-compatible API.
 */

/**
 * Model family type
 * - opus, sonnet, haiku: Anthropic Claude models
 * - glm: GLM (智谱AI) models
 * - Additional families can be added for new providers
 */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'glm' | string;

export interface ModelInfo {
	/** Full model identifier */
	id: string;
	/** Display name for the model */
	name: string;
	/** Short alias for quick reference */
	alias: string;
	/** Model family */
	family: ModelFamily;
	/** Provider that owns this model (e.g., 'anthropic', 'glm', 'deepseek') */
	provider: string;
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
