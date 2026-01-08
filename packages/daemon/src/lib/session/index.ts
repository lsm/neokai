/**
 * Session module - Session management components
 *
 * This module contains all components related to session lifecycle management:
 * - SessionManager: Main orchestrator for session operations
 * - SessionCache: In-memory session caching with lazy loading
 * - SessionLifecycle: Session CRUD operations
 * - SubSessionManager: Sub-session creation and management
 * - ToolsConfig: Global tools configuration
 * - MessagePersistence: User message persistence logic
 */

// Main orchestrator (re-exported from parent for backward compatibility)
export { SessionManager } from './session-manager';

// Extracted components
export { SessionCache } from './session-cache';
export { SessionLifecycle } from './session-lifecycle';
export { SubSessionManager } from './sub-session-manager';
export { ToolsConfigManager } from './tools-config';
export { MessagePersistence, buildMessageContent } from './message-persistence';
