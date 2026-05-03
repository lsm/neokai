import { EventEmitter } from 'node:events';
import { Database } from './index';

/**
 * Scope metadata carried by table change events.
 *
 * When a write method can identify which entity (session, task, etc.) was
 * affected, the scope is populated so that `LiveQueryEngine` can skip
 * re-evaluating queries that are scoped to unrelated entities.
 */
export interface TableChangeScope {
	sessionId?: string;
}

export interface TableChangeEvent {
	tables: string[];
	versions: Record<string, number>;
	/**
	 * When present, describes the entity that triggered this change.
	 * Consumers (e.g. LiveQueryEngine) can use this to skip re-evaluation
	 * of queries whose scope does not overlap.
	 */
	scope?: TableChangeScope;
}

export interface TableVersionEvent {
	table: string;
	version: number;
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
	 *
	 * @param scope - Optional scope info identifying the affected entity.
	 */
	notifyChange(table: string, scope?: TableChangeScope): void;
}

// Static mapping from facade method name to table name
const METHOD_TABLE_MAP: Record<string, string> = {
	// Session operations
	createSession: 'sessions',
	updateSession: 'sessions',
	deleteSession: 'sessions',
	// SDK Message operations
	saveSDKMessage: 'sdk_messages',
	saveUserMessage: 'sdk_messages',
	updateMessageStatus: 'sdk_messages',
	updateMessageTimestamp: 'sdk_messages',
	deleteMessagesAfter: 'sdk_messages',
	deleteMessagesAtAndAfter: 'sdk_messages',
	// Settings operations
	saveGlobalToolsConfig: 'global_tools_config',
	saveGlobalSettings: 'global_settings',
	updateGlobalSettings: 'global_settings',
	// GitHub Mapping operations
	createGitHubMapping: 'room_github_mappings',
	updateGitHubMapping: 'room_github_mappings',
	deleteGitHubMapping: 'room_github_mappings',
	deleteGitHubMappingByRoomId: 'room_github_mappings',
	// Inbox Item operations
	createInboxItem: 'inbox_items',
	updateInboxItemStatus: 'inbox_items',
	dismissInboxItem: 'inbox_items',
	routeInboxItem: 'inbox_items',
	blockInboxItem: 'inbox_items',
	deleteInboxItem: 'inbox_items',
	deleteInboxItemsForRepository: 'inbox_items',
};

/**
 * Scope extractors for write methods.
 *
 * When a method writes to a scoped table, the extractor returns a
 * `TableChangeScope` identifying the affected entity. This allows
 * `LiveQueryEngine` to skip re-evaluating queries whose scope does
 * not overlap (e.g. writing a message for session A should not
 * re-evaluate queries scoped to session B).
 *
 * Methods without an extractor fall back to table-wide invalidation.
 */
const METHOD_SCOPE_EXTRACTORS: Record<string, (args: unknown[]) => TableChangeScope> = {
	// SDK Message operations — first argument is always `sessionId`
	saveSDKMessage: (args) => ({ sessionId: args[0] as string }),
	saveUserMessage: (args) => ({ sessionId: args[0] as string }),
	deleteMessagesAfter: (args) => ({ sessionId: args[0] as string }),
	deleteMessagesAtAndAfter: (args) => ({ sessionId: args[0] as string }),
};

export function createReactiveDatabase(db: Database): ReactiveDatabase {
	const emitter = new EventEmitter();
	const tableVersions: Record<string, number> = {};
	let transactionDepth = 0;
	const pendingTables = new Set<string>();
	/** Scope accumulated during a transaction. Multiple scoped writes merge. */
	let pendingScope: TableChangeScope | undefined;

	function getVersion(table: string): number {
		return tableVersions[table] ?? 0;
	}

	function mergeScope(
		into: TableChangeScope | undefined,
		from: TableChangeScope | undefined
	): TableChangeScope | undefined {
		if (!from) return into;
		if (!into) return { ...from };
		// If both have sessionId and they differ, clear it (indeterminate scope)
		if (
			into.sessionId !== undefined &&
			from.sessionId !== undefined &&
			into.sessionId !== from.sessionId
		) {
			return undefined;
		}
		return { sessionId: from.sessionId ?? into.sessionId };
	}

	function incrementAndEmit(table: string, scope?: TableChangeScope): void {
		tableVersions[table] = getVersion(table) + 1;
		const version = tableVersions[table];

		if (transactionDepth > 0) {
			pendingTables.add(table);
			pendingScope = mergeScope(pendingScope, scope);
			return;
		}

		const versionEvent: TableVersionEvent = { table, version };
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
		const scope = pendingScope;
		pendingScope = undefined;

		const versions: Record<string, number> = {};
		for (const table of tables) {
			const version = getVersion(table);
			versions[table] = version;
			const versionEvent: TableVersionEvent = { table, version };
			emitter.emit(`change:${table}`, versionEvent);
		}

		const changeEvent: TableChangeEvent = { tables, versions, scope };
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

			const table = METHOD_TABLE_MAP[prop];
			if (!table) {
				// Bind to original target so methods that access private fields (e.g.
				// Database#rawDb or BunDatabase's internal Statement constructor) work
				// correctly when called through the proxy.
				return (value as (...args: unknown[]) => unknown).bind(target);
			}

			// Wrap the write method to emit change events on success
			return function (this: Database, ...args: unknown[]) {
				const result = (value as (...a: unknown[]) => unknown).apply(target, args);
				// Only emit if the call didn't throw
				const scopeExtractor = METHOD_SCOPE_EXTRACTORS[prop];
				const scope = scopeExtractor ? scopeExtractor(args) : undefined;
				incrementAndEmit(table, scope);
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
				pendingScope = undefined;
			}
		},
		notifyChange(table: string, scope?: TableChangeScope): void {
			incrementAndEmit(table, scope);
		},
	};
	return reactiveDb as ReactiveDatabase;
}
