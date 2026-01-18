/**
 * Session Manager - Re-export for backward compatibility
 *
 * The SessionManager class has been refactored into the session/ module.
 * This file re-exports for backward compatibility with existing imports.
 *
 * @see packages/daemon/src/lib/session/session-manager.ts for the implementation
 */

export { SessionManager } from "./session";
