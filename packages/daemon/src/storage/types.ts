/**
 * Shared SQLite types for database repositories.
 */

/**
 * SQLite parameter value type.
 * These are the valid types that can be bound to SQLite prepared statement parameters.
 */
export type SQLiteValue =
  | string
  | number
  | boolean
  | null
  | Buffer
  | Uint8Array;
