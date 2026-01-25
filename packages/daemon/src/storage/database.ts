/**
 * Database re-export for backward compatibility.
 *
 * This file exists to maintain backward compatibility with existing imports that reference
 * 'storage/database' directly. All functionality has been decomposed into:
 *
 * - database-core.ts - Core infrastructure
 * - schema/ - Table creation and migrations
 * - repositories/ - CRUD operations for each domain
 * - index.ts - Facade class that composes all repositories
 *
 * New code should import from './storage' or './storage/index'.
 */

export { Database } from './index';
export type { SQLiteValue } from './types';
