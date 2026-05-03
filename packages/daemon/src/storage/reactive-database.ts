import { EventEmitter } from 'node:events';
import { Database } from './index';

/**
 * Scope metadata attached to table-change events when the change can be
 * attributed to a specific context (e.g. a single session).
 *
 * When present, LiveQueryEngine can skip re-evaluating queries that are
 * clearly unrelated to the scope — for example, a `messages.bySession`
 * subscription for session B should not re-evaluate when session A writes a
 * message.
 */
export interface TableChangeScope {
	/** The session that produced the write, when known. */
	sessionId?: string;
}

export interface TableChangeEvent {
	tables: string[];
	versions: Record<string, number>;
	/** Scope metadata for the change. Only populated for single-table, non-transaction events. */
	scope?: TableChangeScope;
}

export interface TableVersionEvent {
	table: string;
	version: number;
	scope?: TableChangeScope;
}

export interface ReactiveDatabase {
	db: Database;
	on(event: 'change', listener: (data: TableChangeEvent) => void): void;
	on(event: `change:${string}`, listener: (data: TableVersionEvent) => void): void;
	off(event: string, listener: (...args: unknown[]) => void): void;
	getTableVersion(table: string): number;
	/**
	 * Begin a batch transaction. All write events are suppressed until
	 * commitTransaction() is called, at which point a single deduplicated
	 * change event is emitted per affected table. Supports nesting.
	 */
	beginTransaction(): void;
	/**
	 * Commit a batch transaction. If this is the outermost transaction,
	 * all pending table changes are flushed as deduplicated events.
	 */
	commitTransaction(): void;
	/**
	 * Abort a batch transaction without emitting any events.
	 * Pending changes accumulated during this transaction are discarded.
	 * Supports nesting — only the outermost abort clears pending state.
	 */
	abortTransaction(): void;
	/**
	 * Manually notify that a table has changed.
	 * Used for tables whose writes bypass the proxy (e.g., direct SQL via external repos).
	 */
	notifyChange(table: string): void;
}

// Mapping from facade method name to table name + optional scope extractor.
// When a scope extractor is provided, the proxy extracts scope metadata from
// the method arguments and attaches it to the emitted change event. This
// allows LiveQueryEngine to skip re-evaluating unrelated queries.
interface MethodMapping {
	table: string;
	/** Extract scope from the method's positional arguments. */
	extractScope?: (args: unknown[]) => TableChangeScope;
}

const METHOD_TABLE_MAP: Record<string, MethodMapping> = {
	// Session operations
	createSession: { table: 'sessions' },
	updateSession: { table: 'sessions' },
	deleteSession: { table: 'sessions' },
	// SDK Message operations — scoped by sessionId where available
	saveSDKMessage: {
		table: 'sdk_messages',
		extractScope: (args) => ({ sessionId: args[0] as string }),
	},
	saveUserMessage: {
		table: 'sdk_messages',
		extractScope: (args) => ({ sessionId: args[0] as string }),
	},
	updateMessageStatus: { table: 'sdk_messages' }, // args are messageIds, no sessionId
	updateMessageTimestamp: { table: 'sdk_messages' }, // args are messageId, no sessionId
	deleteMessagesAfter: {
		table: 'sdk_messages',
		extractScope: (args) => ({ sessionId: args[0] as string }),
	},
	deleteMessagesAtAndAfter: {
		table: 'sdk_messages',
		extractScope: (args) => ({ sessionId: args[0] as string }),
	},
	// Settings operations
	saveGlobalToolsConfig: { table: 'global_tools_config' },
	saveGlobalSettings: { table: 'global_settings' },
	updateGlobalSettings: { table: 'global_settings' },
	// GitHub Mapping operations
	createGitHubMapping: { table: 'room_github_mappings' },
	updateGitHubMapping: { table: 'room_github_mappings' },
	deleteGitHubMapping: { table: 'room_github_mappings' },
	deleteGitHubMappingByRoomId: { table: 'room_github_mappings' },
	// Inbox Item operations
	createInboxItem: { table: 'inbox_items' },
	updateInboxItemStatus: { table: 'inbox_items' },
	dismissInboxItem: { table: 'inbox_items' },
	routeInboxItem: { table: 'inbox_items' },
	blockInboxItem: { table: 'inbox_items' },
	deleteInboxItem: { table: 'inbox_items' },
	deleteInboxItemsForRepository: { table: 'inbox_items' },
};

export function createReactiveDatabase(db: Database): ReactiveDatabase {
	const emitter = new EventEmitter();
	const tableVersions: Record<string, number> = {};
	let transactionDepth = 0;
	const pendingTables = new Set<string>();

	function getVersion(table: string): number {
		return tableVersions[table] ?? 0;
	}

	function incrementAndEmit(table: string, scope?: TableChangeScope): void {
		tableVersions[table] = getVersion(table) + 1;
		const version = tableVersions[table];

		if (transactionDepth > 0) {
			pendingTables.add(table);
			return;
		}

		const versionEvent: TableVersionEvent = { table, version, scope };
		emitter.emit(`change:${table}`, versionEvent);

		const changeEvent: TableChangeEvent = {
			tables: [table],
			versions: { [table]: version },
			scope,
		};
		emitter.emit('change', changeEvent);
	}

	function flushPendingTables(): void {
		if (pendingTables.size === 0) return;

		const tables = Array.from(pendingTables);
		pendingTables.clear();

		const versions: Record<string, number> = {};
		for (const table of tables) {
			const version = getVersion(table);
			versions[table] = version;
			const versionEvent: TableVersionEvent = { table, version };
			emitter.emit(`change:${table}`, versionEvent);
		}

		// Transaction flushes do not carry scope — multiple writes may target
		// different sessions, making single-scope attribution inaccurate.
		const changeEvent: TableChangeEvent = { tables, versions };
		emitter.emit('change', changeEvent);
	}

	const proxied = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'beginTransaction') return reactiveDb.beginTransaction;
			if (prop === 'commitTransaction') return reactiveDb.commitTransaction;
			if (prop === 'abortTransaction') return reactiveDb.abortTransaction;

			const value = Reflect.get(target, prop, receiver);

			if (typeof prop !== 'string' || typeof value !== 'function') {
				return value;
			}

			const mapping = METHOD_TABLE_MAP[prop];
			if (!mapping) {
				// Bind to original target so methods that access private fields (e.g.
				// Database#rawDb or BunDatabase's internal Statement constructor) work
				// correctly when called through the proxy.
				return (value as (...args: unknown[]) => unknown).bind(target);
			}

			// Wrap the write method to emit change events on success
			return function (this: Database, ...args: unknown[]) {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				// Only emit if the call didn't throw
				const scope = mapping.extractScope?.(args);
				incrementAndEmit(mapping.table, scope);
				return result;
			};
		},
	});

	const reactiveDb = {
		db: proxied,
		on(event: string, listener: (...args: unknown[]) => void): void {
			emitter.on(event, listener);
		},
		off(event: string, listener: (...args: unknown[]) => void): void {
			emitter.off(event, listener);
		},
		getTableVersion(table: string): number {
			return getVersion(table);
		},
		beginTransaction(): void {
			transactionDepth += 1;
		},
		commitTransaction(): void {
			if (transactionDepth <= 0) return;
			transactionDepth -= 1;
			if (transactionDepth === 0) {
				flushPendingTables();
			}
		},
		abortTransaction(): void {
			if (transactionDepth <= 0) return;
			transactionDepth -= 1;
			if (transactionDepth === 0) {
				pendingTables.clear();
			}
		},
		notifyChange(table: string): void {
			incrementAndEmit(table);
		},
	};
	return reactiveDb as ReactiveDatabase;
}
