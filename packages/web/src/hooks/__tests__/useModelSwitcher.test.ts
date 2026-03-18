// @ts-nocheck
/**
 * Tests for useModelSwitcher Hook
 *
 * Tests model information loading and switching for a session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/preact';
import {
	useModelSwitcher,
	MODEL_FAMILY_ICONS,
	getModelFamilyIcon,
	getProviderLabel,
	groupModelsByProvider,
} from '../useModelSwitcher.ts';

// Mock the connection manager
const mockGetHubIfConnected = vi.fn();

vi.mock('../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => mockGetHubIfConnected(),
	},
}));

// Mock toast
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
const mockToastInfo = vi.fn();

vi.mock('../../lib/toast', () => ({
	toast: {
		success: (msg: string) => mockToastSuccess(msg),
		error: (msg: string) => mockToastError(msg),
		info: (msg: string) => mockToastInfo(msg),
	},
}));

describe('useModelSwitcher', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockGetHubIfConnected.mockReturnValue({
			request: vi.fn().mockResolvedValue({ acknowledged: true }),
			onEvent: vi.fn().mockReturnValue(() => {}),
			joinRoom: vi.fn(),
			leaveRoom: vi.fn(),
			isConnected: vi.fn().mockReturnValue(true),
			onConnection: vi.fn().mockReturnValue(() => {}),
		});
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe('initialization', () => {
		it('should initialize with empty model state', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			expect(result.current.currentModel).toBe('');
			expect(result.current.currentModelInfo).toBeNull();
			expect(result.current.availableModels).toEqual([]);
			expect(result.current.switching).toBe(false);
		});

		it('should provide required functions', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			expect(typeof result.current.reload).toBe('function');
			expect(typeof result.current.switchModel).toBe('function');
		});

		it('should initialize loading state', () => {
			const { result } = renderHook(() => useModelSwitcher('session-1'));

			expect(typeof result.current.loading).toBe('boolean');
		});
	});

	describe('MODEL_FAMILY_ICONS', () => {
		it('should have icons for all model families', () => {
			expect(MODEL_FAMILY_ICONS.opus).toBeDefined();
			expect(MODEL_FAMILY_ICONS.sonnet).toBeDefined();
			expect(MODEL_FAMILY_ICONS.haiku).toBeDefined();
		});

		it('should have emoji icons', () => {
			expect(typeof MODEL_FAMILY_ICONS.opus).toBe('string');
			expect(typeof MODEL_FAMILY_ICONS.sonnet).toBe('string');
			expect(typeof MODEL_FAMILY_ICONS.haiku).toBe('string');
		});

		it('should have glm icon for GLM models', () => {
			expect(MODEL_FAMILY_ICONS.glm).toBeDefined();
			expect(typeof MODEL_FAMILY_ICONS.glm).toBe('string');
		});

		it('should have default icon for unknown families', () => {
			expect(MODEL_FAMILY_ICONS.__default__).toBeDefined();
			expect(typeof MODEL_FAMILY_ICONS.__default__).toBe('string');
		});

		it('should have distinct icons for each family', () => {
			const icons = [
				MODEL_FAMILY_ICONS.opus,
				MODEL_FAMILY_ICONS.sonnet,
				MODEL_FAMILY_ICONS.haiku,
				MODEL_FAMILY_ICONS.glm,
			];
			const uniqueIcons = new Set(icons);
			expect(uniqueIcons.size).toBe(4);
		});

		it('should have gpt icon for OpenAI models', () => {
			expect(MODEL_FAMILY_ICONS.gpt).toBeDefined();
			expect(typeof MODEL_FAMILY_ICONS.gpt).toBe('string');
		});

		it('should have gemini icon for Gemini models', () => {
			expect(MODEL_FAMILY_ICONS.gemini).toBeDefined();
			expect(typeof MODEL_FAMILY_ICONS.gemini).toBe('string');
		});
	});

	describe('getModelFamilyIcon', () => {
		it('should return correct icon for known families', () => {
			expect(getModelFamilyIcon('opus')).toBe(MODEL_FAMILY_ICONS.opus);
			expect(getModelFamilyIcon('sonnet')).toBe(MODEL_FAMILY_ICONS.sonnet);
			expect(getModelFamilyIcon('haiku')).toBe(MODEL_FAMILY_ICONS.haiku);
			expect(getModelFamilyIcon('glm')).toBe(MODEL_FAMILY_ICONS.glm);
			expect(getModelFamilyIcon('gpt')).toBe(MODEL_FAMILY_ICONS.gpt);
			expect(getModelFamilyIcon('gemini')).toBe(MODEL_FAMILY_ICONS.gemini);
		});

		it('should return default icon for unknown families', () => {
			expect(getModelFamilyIcon('unknown')).toBe(MODEL_FAMILY_ICONS.__default__);
			expect(getModelFamilyIcon('random-family')).toBe(MODEL_FAMILY_ICONS.__default__);
		});
	});

	describe('getProviderLabel', () => {
		it('should return correct label for known providers', () => {
			expect(getProviderLabel('anthropic')).toBe('Anthropic');
			expect(getProviderLabel('glm')).toBe('GLM');
			expect(getProviderLabel('anthropic-copilot')).toBe('Copilot');
			expect(getProviderLabel('anthropic-codex')).toBe('Codex');
		});

		it('should return the provider string for unknown providers', () => {
			expect(getProviderLabel('unknown')).toBe('unknown');
			expect(getProviderLabel('some-provider')).toBe('some-provider');
		});
	});

	describe('loadModelInfo with mocked hub', () => {
		it('should load current model and available models on mount', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: {
							id: 'claude-sonnet-4-20250514',
							name: 'Claude Sonnet 4',
							family: 'sonnet',
						},
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'claude-sonnet-4-20250514',
								display_name: 'Claude Sonnet 4',
								description: 'Fast model',
							},
							{
								id: 'claude-opus-4-5-20251101',
								display_name: 'Claude Opus 4.5',
								description: 'Best model',
							},
							{
								id: 'claude-3-5-haiku-20241022',
								display_name: 'Claude Haiku',
								description: 'Quick model',
							},
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.currentModel).toBe('claude-sonnet-4-20250514');
			expect(result.current.currentModelInfo).toEqual({
				id: 'claude-sonnet-4-20250514',
				name: 'Claude Sonnet 4',
				family: 'sonnet',
			});
			expect(result.current.availableModels.length).toBe(3);
		});

		it('should classify models by family correctly', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{ id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
							{ id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
							{ id: 'claude-3-5-haiku-20241022', display_name: 'Haiku', description: '' },
							{ id: 'glm-4-plus', display_name: 'GLM 4', description: '' },
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const families = result.current.availableModels.map((m) => m.family);
			expect(families).toContain('opus');
			expect(families).toContain('sonnet');
			expect(families).toContain('haiku');
			expect(families).toContain('glm');
		});

		it('should set glm provider for glm models', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'glm-4-plus',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{ id: 'glm-4-plus', display_name: 'GLM 4 Plus', description: '', provider: 'glm' },
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const glmModel = result.current.availableModels.find((m) => m.id === 'glm-4-plus');
			expect(glmModel?.provider).toBe('glm');
			expect(glmModel?.family).toBe('glm');
		});

		it('should detect gpt family and anthropic-copilot provider for Copilot GPT models', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'gpt-5.3-codex',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'gpt-5.3-codex',
								display_name: 'GPT-5.3 Codex (Copilot)',
								description: '',
								provider: 'anthropic-copilot',
							},
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const gptModel = result.current.availableModels.find((m) => m.id === 'gpt-5.3-codex');
			expect(gptModel?.provider).toBe('anthropic-copilot');
			expect(gptModel?.family).toBe('gpt');
		});

		it('should detect gemini family and anthropic-copilot provider for Copilot Gemini models', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'gemini-3-pro-preview',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'gemini-3-pro-preview',
								display_name: 'Gemini 3.1 Pro (Copilot)',
								description: '',
								provider: 'anthropic-copilot',
							},
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const geminiModel = result.current.availableModels.find(
				(m) => m.id === 'gemini-3-pro-preview'
			);
			expect(geminiModel?.provider).toBe('anthropic-copilot');
			expect(geminiModel?.family).toBe('gemini');
		});

		it('should detect claude family via copilot provider', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-opus-4.6',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'claude-opus-4.6',
								display_name: 'Claude Opus 4.6 (Copilot)',
								description: '',
								provider: 'anthropic-copilot',
								alias: 'copilot-anthropic-opus',
							},
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const claudeModel = result.current.availableModels.find((m) => m.id === 'claude-opus-4.6');
			expect(claudeModel?.provider).toBe('anthropic-copilot');
			expect(claudeModel?.family).toBe('opus');
		});

		it('should sort models by family order', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{ id: 'claude-3-5-haiku-20241022', display_name: 'Haiku', description: '' },
							{ id: 'glm-4-plus', display_name: 'GLM', description: '' },
							{ id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
							{ id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const families = result.current.availableModels.map((m) => m.family);
			// Should be sorted: opus, sonnet, haiku, glm
			expect(families).toEqual(['opus', 'sonnet', 'haiku', 'glm']);
		});

		it('should handle error during load gracefully', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValue({ acknowledged: true })
					.mockRejectedValue(new Error('Network error')),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// Error should be handled gracefully (no throw)
		});

		it('should handle no hub connection', async () => {
			mockGetHubIfConnected.mockReturnValue(null);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			// Should handle gracefully
			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.currentModel).toBe('');
		});
	});

	describe('switchModel', () => {
		it('should show info toast when switching to same model', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: { id: 'claude-sonnet-4-20250514', name: 'Sonnet', provider: 'anthropic' },
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-sonnet-4-20250514', provider: 'anthropic' });
			});

			expect(mockToastInfo).toHaveBeenCalledWith(expect.stringContaining('Already using'));
		});

		it('should switch model successfully', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{ id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: '' },
							{ id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: '' },
						],
					})
					.mockResolvedValueOnce({
						success: true,
						model: 'claude-opus-4-5-20251101',
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(result.current.currentModel).toBe('claude-opus-4-5-20251101');
			expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Switched to'));
		});

		it('should handle switch failure from server', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] })
					.mockResolvedValueOnce({
						success: false,
						error: 'Model not available',
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(mockToastError).toHaveBeenCalledWith('Model not available');
		});

		it('should handle switch failure with default error', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] })
					.mockResolvedValueOnce({
						success: false,
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(mockToastError).toHaveBeenCalledWith('Failed to switch model');
		});

		it('should handle switch error with no connection', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// Now set mock to return null for the switch call
			mockGetHubIfConnected.mockReturnValue(null);

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(mockToastError).toHaveBeenCalledWith('Not connected to server');
		});

		it('should handle switch exception', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValue({ acknowledged: true })
					.mockImplementation((method: string) => {
						if (method === 'session.model.get') {
							return Promise.resolve({
								currentModel: 'claude-sonnet-4-20250514',
								modelInfo: null,
							});
						}
						if (method === 'models.list') {
							return Promise.resolve({ models: [] });
						}
						if (method === 'session.model.switch') {
							return Promise.reject(new Error('Connection lost'));
						}
						return Promise.resolve({});
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(mockToastError).toHaveBeenCalledWith('Connection lost');
		});

		it('should set switching state during switch', async () => {
			// Track switching states throughout the switch operation
			const switchingStates: boolean[] = [];

			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] })
					.mockResolvedValueOnce({
						success: true,
						model: 'claude-opus-4-5-20251101',
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// Initial state should be not switching
			expect(result.current.switching).toBe(false);
			switchingStates.push(result.current.switching);

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			// After switch completes, should not be switching
			expect(result.current.switching).toBe(false);
			switchingStates.push(result.current.switching);

			// Verify the switch was called
			expect(mockHub.request).toHaveBeenCalledWith('session.model.switch', {
				sessionId: 'session-1',
				model: 'claude-opus-4-5-20251101',
				provider: 'anthropic',
			});
		});

		it('should update currentModelInfo after successful switch', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{ id: 'claude-sonnet-4-20250514', display_name: 'Sonnet', description: 'Fast' },
							{ id: 'claude-opus-4-5-20251101', display_name: 'Opus', description: 'Best' },
						],
					})
					.mockResolvedValueOnce({
						success: true,
						model: 'claude-opus-4-5-20251101',
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101', provider: 'anthropic' });
			});

			expect(result.current.currentModelInfo?.id).toBe('claude-opus-4-5-20251101');
		});
	});

	describe('switchModel - cross-provider', () => {
		it('should match currentModelInfo by provider after cross-provider switch', async () => {
			// Two providers both expose claude-sonnet-4-20250514; the post-switch find must
			// prefer the entry for the provider that was actually switched to.
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'claude-sonnet-4-20250514',
								display_name: 'Sonnet (Anthropic)',
								description: '',
								provider: 'anthropic',
							},
							{
								id: 'claude-sonnet-4-20250514',
								display_name: 'Sonnet (Copilot)',
								description: '',
								provider: 'anthropic-copilot',
							},
						],
					})
					.mockResolvedValueOnce({
						success: true,
						model: 'claude-sonnet-4-20250514',
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				// Switch to the copilot variant
				await result.current.switchModel({
					id: 'claude-sonnet-4-20250514',
					provider: 'anthropic-copilot',
				});
			});

			// Should resolve to the copilot entry, not the anthropic one
			expect(result.current.currentModelInfo?.provider).toBe('anthropic-copilot');
			expect(result.current.currentModelInfo?.name).toBe('Sonnet (Copilot)');
		});
	});

	describe('switchModel - provider validation', () => {
		it('should show error when provider is missing from model', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.switchModel({ id: 'claude-opus-4-5-20251101' });
			});

			expect(mockToastError).toHaveBeenCalledWith('Model provider information is missing');
			// Should not have made an RPC call for the switch
			expect(mockHub.request).not.toHaveBeenCalledWith('session.model.switch', expect.anything());
		});
	});

	describe('reload', () => {
		it('should reload model info', async () => {
			const mockHub = {
				request: vi
					.fn()
					// First load (mount)
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] })
					// Second load (reload)
					.mockResolvedValueOnce({
						currentModel: 'claude-opus-4-5-20251101',
						modelInfo: { id: 'claude-opus-4-5-20251101', name: 'Opus' },
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.currentModel).toBe('claude-sonnet-4-20250514');

			await act(async () => {
				await result.current.reload();
			});

			expect(result.current.currentModel).toBe('claude-opus-4-5-20251101');
		});
	});

	describe('sessionId changes', () => {
		it('should reload when sessionId changes', async () => {
			const mockHub = {
				request: vi
					.fn()
					// First load (session-1)
					.mockResolvedValueOnce({
						currentModel: 'model-1',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] })
					// Second load (session-2)
					.mockResolvedValueOnce({
						currentModel: 'model-2',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result, rerender } = renderHook(({ sessionId }) => useModelSwitcher(sessionId), {
				initialProps: { sessionId: 'session-1' },
			});

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.currentModel).toBe('model-1');

			rerender({ sessionId: 'session-2' });

			await waitFor(() => {
				expect(result.current.currentModel).toBe('model-2');
			});
		});
	});

	describe('function stability', () => {
		it('should return stable reload function on same sessionId', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-sonnet-4-20250514',
						modelInfo: null,
					})
					.mockResolvedValueOnce({ models: [] }),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result, rerender } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			const firstReload = result.current.reload;

			rerender();

			expect(result.current.reload).toBe(firstReload);
		});
	});

	describe('groupModelsByProvider', () => {
		it('should return an empty map for empty input', () => {
			const result = groupModelsByProvider([]);
			expect(result.size).toBe(0);
		});

		it('should group models by provider', () => {
			const models = [
				{ id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
				{ id: 'claude-opus-4', provider: 'anthropic', family: 'opus', name: 'Opus' },
				{
					id: 'claude-sonnet-4',
					provider: 'anthropic-copilot',
					family: 'sonnet',
					name: 'Sonnet (Copilot)',
				},
			];
			const result = groupModelsByProvider(models as any);
			expect(result.size).toBe(2);
			expect(result.get('anthropic')).toHaveLength(2);
			expect(result.get('anthropic-copilot')).toHaveLength(1);
		});

		it('should default to anthropic provider when model has no provider', () => {
			const models = [{ id: 'claude-sonnet-4', family: 'sonnet', name: 'Sonnet' }];
			const result = groupModelsByProvider(models as any);
			expect(result.has('anthropic')).toBe(true);
			expect(result.get('anthropic')).toHaveLength(1);
		});

		it('should preserve all models within each group', () => {
			const models = [
				{ id: 'glm-4-plus', provider: 'glm', family: 'glm', name: 'GLM 4 Plus' },
				{ id: 'glm-4-flash', provider: 'glm', family: 'glm', name: 'GLM 4 Flash' },
				{ id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
			];
			const result = groupModelsByProvider(models as any);
			expect(result.get('glm')).toHaveLength(2);
			expect(result.get('anthropic')).toHaveLength(1);
		});

		it('should maintain insertion order of models within each group', () => {
			const models = [
				{ id: 'claude-opus-4', provider: 'anthropic', family: 'opus', name: 'Opus' },
				{ id: 'claude-sonnet-4', provider: 'anthropic', family: 'sonnet', name: 'Sonnet' },
				{ id: 'claude-haiku-4', provider: 'anthropic', family: 'haiku', name: 'Haiku' },
			];
			const result = groupModelsByProvider(models as any);
			const anthropicModels = result.get('anthropic')!;
			expect(anthropicModels[0].id).toBe('claude-opus-4');
			expect(anthropicModels[1].id).toBe('claude-sonnet-4');
			expect(anthropicModels[2].id).toBe('claude-haiku-4');
		});

		it('should handle all supported providers', () => {
			const models = [
				{ id: 'm1', provider: 'anthropic', family: 'sonnet', name: 'M1' },
				{ id: 'm2', provider: 'anthropic-copilot', family: 'sonnet', name: 'M2' },
				{ id: 'm3', provider: 'anthropic-codex', family: 'sonnet', name: 'M3' },
				{ id: 'm4', provider: 'glm', family: 'glm', name: 'M4' },
				{ id: 'm5', provider: 'minimax', family: 'minimax', name: 'M5' },
			];
			const result = groupModelsByProvider(models as any);
			expect(result.size).toBe(5);
			expect(result.has('anthropic')).toBe(true);
			expect(result.has('anthropic-copilot')).toBe(true);
			expect(result.has('anthropic-codex')).toBe(true);
			expect(result.has('glm')).toBe(true);
			expect(result.has('minimax')).toBe(true);
		});
	});

	describe('model alias extraction', () => {
		it('should extract alias from model ID', async () => {
			const mockHub = {
				request: vi
					.fn()
					.mockResolvedValueOnce({
						currentModel: 'claude-opus-4-5-20251101',
						modelInfo: null,
					})
					.mockResolvedValueOnce({
						models: [
							{
								id: 'claude-opus-4-5-20251101',
								display_name: 'Opus',
								description: '',
								alias: 'copilot-anthropic-opus',
								provider: 'anthropic-copilot',
							},
						],
					}),
			};
			mockGetHubIfConnected.mockReturnValue(mockHub);

			const { result } = renderHook(() => useModelSwitcher('session-1'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			// Server-provided alias is used directly
			expect(result.current.availableModels[0].alias).toBe('copilot-anthropic-opus');
		});
	});
});
