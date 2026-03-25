/**
 * Reference Types
 *
 * Core type definitions for the @ reference system.
 * References allow users to mention tasks, goals, files, and folders
 * in chat inputs using @ref{type:id} syntax.
 */

/**
 * The type of entity being referenced.
 * Union type (not enum) following existing codebase patterns like `SessionType`.
 */
export type ReferenceType = 'task' | 'goal' | 'file' | 'folder';

/**
 * A mention of a reference in text, as inserted by the autocomplete.
 * Stored in message content as @ref{type:id}.
 */
export interface ReferenceMention {
	type: ReferenceType;
	id: string;
	displayText: string;
}

/**
 * A single result returned from the reference.search RPC.
 */
export interface ReferenceSearchResult {
	type: ReferenceType;
	id: string;
	/** Short human-readable ID (e.g. "t-42", "g-7") for tasks and goals */
	shortId?: string;
	/** Primary display text shown in the autocomplete menu */
	displayText: string;
	/** Secondary text shown below displayText (e.g. task status, file path) */
	subtitle?: string;
}

/**
 * A resolved reference with full entity data.
 */
export interface ResolvedReference {
	type: ReferenceType;
	id: string;
	/** Polymorphic — cast based on `type` */
	data: unknown;
}

export interface ResolvedTaskReference extends ResolvedReference {
	type: 'task';
}

export interface ResolvedGoalReference extends ResolvedReference {
	type: 'goal';
}

/** Resolved file reference — data includes content (possibly truncated or absent for binary files) */
export interface ResolvedFileReference extends ResolvedReference {
	type: 'file';
	data: {
		path: string;
		/** UTF-8 text content, or null when the file is binary */
		content: string | null;
		/** True when the file contains binary (non-text) data; content will be null */
		binary: boolean;
		/** True when file content was truncated to stay within payload limits */
		truncated: boolean;
		size: number;
		mtime: string;
	};
}

export interface ResolvedFolderReference extends ResolvedReference {
	type: 'folder';
	data: {
		path: string;
		entries: Array<{
			name: string;
			path: string;
			type: 'file' | 'directory';
		}>;
	};
}

/**
 * Metadata stored in a message blob for all @ references within that message.
 * Uses Record (not Map) because this is serialized to JSON in the sdk_message column.
 *
 * Key is the raw @ref{type:id} token string.
 */
export type ReferenceMetadata = Record<
	string,
	{ type: ReferenceType; id: string; displayText: string; status?: string }
>;

/**
 * Regex for parsing @ref{type:id} tokens from text.
 *
 * Matches: @ref{task:t-42}, @ref{goal:g-7}, @ref{file:src/foo.ts}, @ref{folder:src}
 * Does NOT match: normal @mentions, markdown links
 *
 * NOTE: This regex uses the 'g' flag, so it is stateful.
 * Always reset lastIndex to 0 (or use .exec() in a loop) before reuse.
 */
export const REFERENCE_PATTERN = /@ref\{([^}:]+):([^}]+)\}/g;
