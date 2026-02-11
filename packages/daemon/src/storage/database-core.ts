/**
 * Database Core - Core infrastructure for SQLite database.
 *
 * Responsibilities:
 * - Database initialization with WAL mode
 * - PRAGMA configuration
 * - Backup creation and cleanup
 * - Database path management
 * - Close operation
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { Logger } from '../lib/logger';
import { createTables, runMigrations } from './schema';

export class DatabaseCore {
	private db: BunDatabase;
	private logger = new Logger('Database');

	constructor(private dbPath: string) {
		// Initialize as null until initialize() is called
		// This pattern is necessary because BunDatabase constructor is synchronous
		// but we want to allow async directory creation before opening the DB
		this.db = null as unknown as BunDatabase;
	}

	async initialize(): Promise<void> {
		// Ensure directory exists
		const dir = dirname(this.dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Open database
		this.db = new BunDatabase(this.dbPath);

		// Enable WAL mode for better concurrency and crash recovery
		// WAL mode provides:
		// - Better performance for concurrent reads/writes
		// - Atomic commits (prevents partial writes)
		// - Better crash recovery (no data loss on unexpected shutdown)
		this.db.exec('PRAGMA journal_mode = WAL');

		// Set synchronous mode to NORMAL for durability with good performance
		// NORMAL = fsync only at critical moments (WAL checkpoints)
		// This ensures durability while maintaining performance
		this.db.exec('PRAGMA synchronous = NORMAL');

		// Enable foreign key constraints (required for CASCADE deletes)
		this.db.exec('PRAGMA foreign_keys = ON');

		// Create tables
		createTables(this.db);

		// Run migrations (with automatic backup)
		runMigrations(this.db, () => this.createBackup());
	}

	/**
	 * Get the underlying Bun SQLite database instance
	 * Used by repositories and background job queues that need direct DB access
	 */
	getDb(): BunDatabase {
		return this.db;
	}

	/**
	 * Get the database file path
	 * Used by background job queues to create their own connections to the same DB file
	 */
	getDbPath(): string {
		return this.dbPath;
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Create a backup of the database before migrations
	 * Keeps up to 3 most recent backups to prevent disk bloat
	 */
	private createBackup(): void {
		if (!existsSync(this.dbPath)) return;

		const dir = dirname(this.dbPath);
		const backupDir = join(dir, 'backups');

		// Create backup directory if needed
		if (!existsSync(backupDir)) {
			mkdirSync(backupDir, { recursive: true });
		}

		// Checkpoint WAL to ensure backup has all data
		try {
			this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		} catch {
			// Ignore checkpoint errors
		}

		// Create timestamped backup
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = join(backupDir, `daemon-${timestamp}.db`);

		try {
			copyFileSync(this.dbPath, backupPath);
		} catch (err) {
			this.logger.error('Failed to create backup:', err);
			return;
		}

		// Cleanup old backups (keep only 3 most recent)
		this.cleanupOldBackups(backupDir, 3);
	}

	/**
	 * Remove old backups, keeping only the N most recent
	 */
	private cleanupOldBackups(backupDir: string, keepCount: number): void {
		try {
			const files = readdirSync(backupDir)
				.filter((f) => f.startsWith('daemon-') && f.endsWith('.db'))
				.map((f) => ({
					name: f,
					path: join(backupDir, f),
					mtime: statSync(join(backupDir, f)).mtime.getTime(),
				}))
				.sort((a, b) => b.mtime - a.mtime); // newest first

			// Delete old backups
			for (const file of files.slice(keepCount)) {
				try {
					unlinkSync(file.path);
				} catch {
					// Ignore deletion errors
				}
			}
		} catch {
			// Ignore cleanup errors
		}
	}
}
