/**
 * Tool Components - Barrel export
 *
 * Provides a unified interface for all tool-related components and utilities.
 */

// Types
export type {
  ToolCardVariant,
  ToolIconSize,
  ToolCategory,
  ToolConfig,
  ToolRendererProps,
  ToolIconProps,
  ToolSummaryProps,
  ToolProgressCardProps,
  ToolResultCardProps,
  AuthStatusCardProps,
} from './tool-types.ts';

// Components
export { ToolIcon } from './ToolIcon.tsx';
export { ToolSummary } from './ToolSummary.tsx';
export { ToolProgressCard } from './ToolProgressCard.tsx';
export { ToolResultCard } from './ToolResultCard.tsx';
export { AuthStatusCard } from './AuthStatusCard.tsx';

// Registry
export {
  getToolConfig,
  getToolCategory,
  getCategoryColors,
  registerTool,
  unregisterTool,
  isToolRegistered,
  getAllRegisteredTools,
} from './tool-registry.ts';

// Utilities
export {
  getToolSummary,
  getToolDisplayName,
  getToolColors,
  getIconSizeClasses,
  formatElapsedTime,
  truncateText,
  extractFileName,
  formatJSON,
  isJSONOutput,
  getOutputDisplayText,
  hasCustomRenderer,
  getCustomRenderer,
  shouldExpandByDefault,
  hasLongOutput,
} from './tool-utils.ts';
