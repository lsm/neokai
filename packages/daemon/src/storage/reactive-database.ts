import { EventEmitter } from 'node:events';
import { Database } from './index';

export interface TableChangeEvent {
	tables: string[];
	versions: Record<string, number>;
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
	 */
	notifyChange(table: string): void;
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

export function createReactiveDatabase(db: Database): ReactiveDatabase {
	const emitter = new EventEmitter();
	const tableVersions: Record<string, number> = {};
	let transactionDepth = 0;
	const pendingTables = new Set<string>();

	function getVersion(table: string): number {
		return tableVersions[table] ?? 0;
	}

	function incrementAndEmit(table: string): void {
		tableVersions[table] = getVersion(table) + 1;
		const version = tableVersions[table];

		if (transactionDepth > 0) {
			pendingTables.add(table);
			return;
		}

		const versionEvent: TableVersionEvent = { table, version };
		emitter.emit(`change:${table}`, versionEvent);

		const changeEvent: TableChangeEvent = {
			tables: [table],
			versions: { [table]: version },
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

		const changeEvent: TableChangeEvent = { tables, versions };
		emitter.emit('change', changeEvent);
	}

	const proxied = new Proxy(db, {
		get(target, prop, receiver) {
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
				incrementAndEmit(table);
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
