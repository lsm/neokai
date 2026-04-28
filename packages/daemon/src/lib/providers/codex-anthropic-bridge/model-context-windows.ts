export const MODEL_CONTEXT_WINDOWS = {
	'gpt-5.3-codex': 272000,
	'gpt-5.4': 272000,
	'gpt-5.5': 272000,
	'gpt-5.4-mini': 128000,
	'gpt-5.1-codex-mini': 128000,
} as const;

export type CodexBridgeModelId = keyof typeof MODEL_CONTEXT_WINDOWS;

export function getModelContextWindow(modelId: string): number | undefined {
	return MODEL_CONTEXT_WINDOWS[modelId as CodexBridgeModelId];
}
