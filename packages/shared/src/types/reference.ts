/**
 * Types for the @ reference system.
 *
 * Users can type @ in chat inputs to reference tasks, goals, files, and folders.
 * References are serialized as `@ref{type:id}` in message content.
 */

// ============================================================================
// Core Types
// ============================================================================

/** The type of entity being referenced */
export type ReferenceType = 'task' | 'goal' | 'file' | 'folder';

/**
 * A parsed @ mention from user input.
 * Represents a reference that has been inserted into the input field.
 */
export interface ReferenceMention {
	type: ReferenceType;
	id: string;
	displayText: string;
}

/**
 * A search result returned by the reference search RPC.
 */
export interface ReferenceSearchResult {
	type: ReferenceType;
	id: string;
	/** Short human-readable identifier (e.g. "t-42" for tasks) */
	shortId?: string;
	displayText: string;
	/** Secondary line shown in the autocomplete menu */
	subtitle?: string;
}

/**
 * A resolved reference — the raw entity data retrieved for a given id.
 * The shape of `data` is polymorphic based on `type`.
 */
export interface ResolvedReference {
	type: ReferenceType;
	id: string;
	data: unknown;
}

// ============================================================================
// Resolved Reference Variants
// ============================================================================

export interface ResolvedTaskReference extends ResolvedReference {
	type: 'task';
}

export interface ResolvedGoalReference extends ResolvedReference {
	type: 'goal';
}

export interface ResolvedFileReference extends ResolvedReference {
	type: 'file';
}

export interface ResolvedFolderReference extends ResolvedReference {
	type: 'folder';
}

// ============================================================================
// Message Persistence
// ============================================================================

/**
 * Reference metadata stored in a message blob alongside the message text.
 * Keyed by the serialized reference string (e.g. "@ref{task:t-42}").
 *
 * Uses `Record` rather than `Map` because this is serialized to JSON in the
 * `sdk_message` column.
 */
export type ReferenceMetadata = Record<
	string,
	{
		type: ReferenceType;
		id: string;
		displayText: string;
		/** Optional status snapshot at the time the message was sent */
		status?: string;
	}
>;

// ============================================================================
// Parsing
// ============================================================================

/**
 * Regex that matches serialized @ references in message text.
 *
 * Format: `@ref{type:id}`
 * Example: `@ref{task:t-42}`, `@ref{goal:g-abc}`, `@ref{file:src/index.ts}`
 *
 * Note: This regex uses the `g` flag — reset `lastIndex` or use `matchAll`
 * to avoid stale state between calls.
 */
export const REFERENCE_PATTERN = /@ref\{([^}:]+):([^}]+)\}/g;
