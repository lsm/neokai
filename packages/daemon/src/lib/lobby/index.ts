/**
 * Lobby Package
 *
 * Generalized external message processing system:
 * - Types for external messages and routing
 * - LobbyAgentService for orchestrating all sources
 * - Adapters for different external sources
 */

export { LobbyAgentService, type LobbyAgentContext } from './lobby-agent-service';
export type {
	ExternalMessage,
	ExternalSource,
	ExternalSecurityCheck,
	ExternalRoutingResult,
	RoutingCandidate,
	RoutingDecision,
	ExternalSourceAdapter,
	ExternalMessageCallback,
	LobbyAgentStats,
	LobbyAgentConfig,
} from './types';
export { DEFAULT_LOBBY_AGENT_CONFIG } from './types';
export {
	GitHubAdapter,
	createGitHubAdapter,
	type GitHubAdapterConfig,
} from './adapters/github-adapter';
