/**
 * Lobby Package
 *
 * Generalized external message processing system:
 * - Types for external messages and routing
 * - Adapters for different external sources
 */

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
