export * from './coreTypes.generated.js';
export type { SandboxSettings, SandboxNetworkConfig, SandboxIgnoreViolations, } from '../sandboxTypes.js';
export type { NonNullableUsage } from './sdkUtilityTypes.js';
export declare const HOOK_EVENTS: readonly ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PermissionRequest"];
export declare const EXIT_REASONS: readonly ["clear", "logout", "prompt_input_exit", "other", "bypass_permissions_disabled"];
