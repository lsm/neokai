/**
 * Claude Model Type Definitions
 *
 * This file defines the types for model information.
 * The actual model list is fetched dynamically from the SDK via supportedModels().
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
