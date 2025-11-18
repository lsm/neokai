import { useEffect, useState } from "preact/hooks";
import type { AuthStatus } from "@liuboer/shared";
import { apiClient } from "../lib/api-client.ts";
import { toast } from "../lib/toast.ts";
import { Modal } from "./ui/Modal.tsx";
import { Button } from "./ui/Button.tsx";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"oauth" | "token" | "apikey">("oauth");
  const [apiKey, setApiKey] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [oauthToken, setOauthToken] = useState("");
  const [savingOAuthToken, setSavingOAuthToken] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [showManualOAuthInput, setShowManualOAuthInput] = useState(false);
  const [manualOAuthCode, setManualOAuthCode] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadAuthStatus();
    }
  }, [isOpen]);

  const loadAuthStatus = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getAuthStatus();
      setAuthStatus(response.authStatus);

      // Auto-select tab based on current auth method
      if (response.authStatus.method === "api_key") {
        setActiveTab("apikey");
      } else if (response.authStatus.method === "oauth_token") {
        setActiveTab("token");
      } else {
        setActiveTab("oauth");
      }
    } catch (error) {
      console.error("Failed to load auth status:", error);
      toast.error("Failed to load authentication status");
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = async () => {
    try {
      setStartingOAuth(true);

      // Start OAuth flow
      const response = await apiClient.startOAuthFlow();

      // Open authorization URL in a new window
      const authWindow = window.open(
        response.authorizationUrl,
        "Claude OAuth",
        "width=600,height=700,left=100,top=100"
      );

      if (!authWindow) {
        toast.error("Please allow popups for this site");
        setStartingOAuth(false);
        return;
      }

      toast.info("Please complete the authentication in the popup window");

      // Poll for the OAuth callback in the popup window
      const pollInterval = setInterval(async () => {
        try {
          // Check if popup is closed
          if (authWindow.closed) {
            clearInterval(pollInterval);
            setStartingOAuth(false);
            return;
          }

          // Try to read the popup URL (will fail if on different origin)
          let popupUrl: string;
          try {
            popupUrl = authWindow.location.href;
          } catch (e) {
            // Cross-origin error, popup is still on Claude's domain
            return;
          }

          // Check if we're on the callback URL
          if (popupUrl.includes("console.anthropic.com/oauth/code/callback")) {
            clearInterval(pollInterval);

            // Extract code and state from URL
            const url = new URL(popupUrl);
            const code = url.searchParams.get("code");
            const state = url.searchParams.get("state");

            if (code && state) {
              // Complete OAuth flow
              try {
                const result = await apiClient.completeOAuthFlow({ code, state });

                if (result.success) {
                  toast.success("Successfully authenticated with Claude.ai!");
                  authWindow.close();
                  await loadAuthStatus();
                } else {
                  toast.error("Authentication failed");
                }
              } catch (err) {
                console.error("OAuth completion error:", err);
                toast.error(
                  err instanceof Error
                    ? err.message
                    : "Failed to complete authentication"
                );
              }
            } else {
              toast.error("Invalid OAuth response - missing code or state");
            }

            setStartingOAuth(false);
          }
        } catch (error) {
          // Ignore cross-origin errors during polling
          if (
            error instanceof Error &&
            !error.message.includes("cross-origin")
          ) {
            console.error("Error polling OAuth popup:", error);
          }
        }
      }, 500); // Poll every 500ms

      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        if (!authWindow.closed) {
          authWindow.close();
        }
        setStartingOAuth(false);
      }, 5 * 60 * 1000);
    } catch (error) {
      console.error("Failed to start OAuth flow:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to start OAuth flow"
      );
      setStartingOAuth(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) {
      toast.error("Please enter an API key");
      return;
    }

    try {
      setSavingApiKey(true);
      await apiClient.setApiKey({ apiKey: apiKey.trim() });
      toast.success("API key saved successfully");
      setApiKey("");
      await loadAuthStatus();
    } catch (error) {
      console.error("Failed to save API key:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to save API key"
      );
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleSaveOAuthToken = async () => {
    if (!oauthToken.trim()) {
      toast.error("Please enter a token");
      return;
    }

    try {
      setSavingOAuthToken(true);
      await apiClient.setOAuthToken({ token: oauthToken.trim() });
      toast.success("OAuth token saved successfully");
      setOauthToken("");
      await loadAuthStatus();
    } catch (error) {
      console.error("Failed to save OAuth token:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to save OAuth token"
      );
    } finally {
      setSavingOAuthToken(false);
    }
  };

  const handleManualOAuthComplete = async () => {
    if (!manualOAuthCode.trim()) {
      toast.error("Please paste the authentication code");
      return;
    }

    try {
      setCompletingOAuth(true);

      // Parse the code - format is: "code#state" or just extract from URL params
      let code: string;
      let state: string;

      // Check if it's a URL
      if (manualOAuthCode.includes("console.anthropic.com")) {
        const url = new URL(manualOAuthCode);
        code = url.searchParams.get("code") || "";
        state = url.searchParams.get("state") || "";
      } else if (manualOAuthCode.includes("#")) {
        // Format: code#state
        const parts = manualOAuthCode.split("#");
        code = parts[0];
        state = parts[1] || "";
      } else {
        toast.error("Invalid code format. Please paste the full URL or code");
        setCompletingOAuth(false);
        return;
      }

      if (!code || !state) {
        toast.error("Invalid authentication code - missing code or state");
        setCompletingOAuth(false);
        return;
      }

      // Complete OAuth flow
      const result = await apiClient.completeOAuthFlow({ code, state });

      if (result.success) {
        toast.success("Successfully authenticated with Claude.ai!");
        setShowManualOAuthInput(false);
        setManualOAuthCode("");
        await loadAuthStatus();
      } else {
        toast.error("Authentication failed");
      }
    } catch (error) {
      console.error("OAuth completion error:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to complete authentication"
      );
    } finally {
      setCompletingOAuth(false);
    }
  };

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      await apiClient.logout();
      toast.success("Logged out successfully");
      await loadAuthStatus();
    } catch (error) {
      console.error("Failed to logout:", error);
      toast.error("Failed to logout");
    } finally {
      setLoggingOut(false);
    }
  };

  const formatExpiresAt = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = timestamp - now.getTime();

    if (diff < 0) return "Expired";

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days} day${days > 1 ? "s" : ""}`;
    }

    return `${hours}h ${minutes}m`;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings" size="md">
      <div class="space-y-6">
        {/* Current Auth Status */}
        {loading ? (
          <div class="text-center py-4">
            <div class="text-gray-400">Loading...</div>
          </div>
        ) : authStatus ? (
          <div class="bg-dark-800 rounded-lg p-4 border border-dark-600">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-medium text-gray-300">
                Authentication Status
              </h3>
              {authStatus.isAuthenticated && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  loading={loggingOut}
                >
                  Logout
                </Button>
              )}
            </div>

            {authStatus.isAuthenticated ? (
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <div class="w-2 h-2 bg-green-500 rounded-full" />
                  <span class="text-sm text-gray-200">
                    Authenticated via{" "}
                    <span class="font-medium">
                      {authStatus.method === "oauth"
                        ? "Claude.ai OAuth"
                        : authStatus.method === "oauth_token"
                        ? "OAuth Token"
                        : "API Key"}
                    </span>
                    {authStatus.source === "env" && (
                      <span class="ml-2 px-2 py-0.5 text-xs bg-blue-500/20 text-blue-300 rounded">
                        from env
                      </span>
                    )}
                  </span>
                </div>

                {authStatus.source === "env" && (
                  <div class="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded p-2">
                    ℹ️ Using CLAUDE_CODE_OAUTH_TOKEN from environment variables.
                    To use database credentials, unset this env var.
                  </div>
                )}

                {authStatus.method === "oauth" && authStatus.expiresAt && (
                  <div class="text-xs text-gray-400">
                    Token expires in: {formatExpiresAt(authStatus.expiresAt)}
                  </div>
                )}
              </div>
            ) : (
              <div class="flex items-center gap-2">
                <div class="w-2 h-2 bg-red-500 rounded-full" />
                <span class="text-sm text-gray-400">Not authenticated</span>
              </div>
            )}
          </div>
        ) : null}

        {/* Tab Selector */}
        <div class="border-b border-dark-600">
          <div class="flex gap-4">
            <button
              onClick={() => setActiveTab("oauth")}
              class={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "oauth"
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-gray-400 hover:text-gray-300"
              }`}
            >
              Claude.ai OAuth
            </button>
            <button
              onClick={() => setActiveTab("token")}
              class={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "token"
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-gray-400 hover:text-gray-300"
              }`}
            >
              Long-lived Token
            </button>
            <button
              onClick={() => setActiveTab("apikey")}
              class={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "apikey"
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-gray-400 hover:text-gray-300"
              }`}
            >
              API Key
            </button>
          </div>
        </div>

        {/* OAuth Tab */}
        {activeTab === "oauth" && (
          <div class="space-y-4">
            <div class="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
              <div class="flex items-start gap-3">
                <svg
                  class="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clip-rule="evenodd"
                  />
                </svg>
                <div class="flex-1">
                  <h4 class="text-sm font-medium text-blue-300 mb-1">
                    Use Your Claude Subscription
                  </h4>
                  <p class="text-xs text-blue-200/80">
                    Login with your Claude Max or Pro subscription. Usage will
                    count towards your subscription quota instead of API billing.
                  </p>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <Button
                onClick={handleOAuthLogin}
                loading={startingOAuth}
                fullWidth
                icon={
                  <svg
                    class="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width={2}
                      d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"
                    />
                  </svg>
                }
              >
                Login with Claude.ai
              </Button>

              <div class="relative">
                <div class="absolute inset-0 flex items-center">
                  <div class="w-full border-t border-dark-600"></div>
                </div>
                <div class="relative flex justify-center text-xs">
                  <span class="px-2 bg-dark-900 text-gray-500">or</span>
                </div>
              </div>

              {!showManualOAuthInput ? (
                <button
                  onClick={() => setShowManualOAuthInput(true)}
                  class="w-full text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Paste authentication code manually
                </button>
              ) : (
                <div class="space-y-3 border border-dark-600 rounded-lg p-4">
                  <div class="space-y-2">
                    <label class="block text-sm font-medium text-gray-300">
                      Authentication Code
                    </label>
                    <p class="text-xs text-gray-500">
                      Paste the code from the authentication page (looks like:
                      code#state) or the full URL
                    </p>
                    <textarea
                      value={manualOAuthCode}
                      onInput={(e) =>
                        setManualOAuthCode((e.target as HTMLTextAreaElement).value)}
                      placeholder="CD3N6...#9041a... or full URL"
                      rows={3}
                      class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-xs font-mono"
                    />
                  </div>

                  <div class="flex gap-2">
                    <Button
                      onClick={handleManualOAuthComplete}
                      loading={completingOAuth}
                      disabled={!manualOAuthCode.trim()}
                      fullWidth
                    >
                      Complete Authentication
                    </Button>
                    <Button
                      onClick={() => {
                        setShowManualOAuthInput(false);
                        setManualOAuthCode("");
                      }}
                      variant="secondary"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              <p class="text-xs text-gray-500 text-center">
                Note: This uses your personal Claude subscription quota
              </p>
            </div>
          </div>
        )}

        {/* Long-lived Token Tab */}
        {activeTab === "token" && (
          <div class="space-y-4">
            <div class="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
              <div class="flex items-start gap-3">
                <svg
                  class="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clip-rule="evenodd"
                  />
                </svg>
                <div class="flex-1">
                  <h4 class="text-sm font-medium text-green-300 mb-1">
                    ⭐ Recommended: Simple & Long-lived
                  </h4>
                  <p class="text-xs text-green-200/80">
                    Use a long-lived token from Claude Code CLI (valid for 1 year).
                    Uses your Claude subscription quota without the complexity of OAuth flow.
                  </p>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <div class="bg-dark-800 rounded-lg p-3 border border-dark-600">
                <div class="flex items-start gap-2 text-xs text-gray-400">
                  <span class="text-gray-500">1.</span>
                  <div class="flex-1">
                    <span>Run this command in your terminal:</span>
                    <pre class="mt-1 p-2 bg-dark-950 rounded border border-dark-700 text-blue-300 overflow-x-auto">
                      <code>claude setup-token</code>
                    </pre>
                  </div>
                </div>
                <div class="flex items-start gap-2 text-xs text-gray-400 mt-3">
                  <span class="text-gray-500">2.</span>
                  <span class="flex-1">Copy the token and paste it below</span>
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-300 mb-2">
                  Long-lived OAuth Token
                </label>
                <textarea
                  value={oauthToken}
                  onInput={(e) =>
                    setOauthToken((e.target as HTMLTextAreaElement).value)}
                  placeholder="Paste your long-lived token here..."
                  rows={4}
                  class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-xs font-mono"
                />
              </div>

              <Button
                onClick={handleSaveOAuthToken}
                loading={savingOAuthToken}
                fullWidth
                disabled={!oauthToken.trim()}
              >
                Save Token
              </Button>

              <p class="text-xs text-gray-500">
                Note: This uses your Claude subscription quota (valid for 1 year)
              </p>
            </div>
          </div>
        )}

        {/* API Key Tab */}
        {activeTab === "apikey" && (
          <div class="space-y-4">
            <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
              <div class="flex items-start gap-3">
                <svg
                  class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fill-rule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clip-rule="evenodd"
                  />
                </svg>
                <div class="flex-1">
                  <h4 class="text-sm font-medium text-yellow-300 mb-1">
                    Official API Method
                  </h4>
                  <p class="text-xs text-yellow-200/80">
                    Use an Anthropic API key for pay-as-you-go billing. This is
                    the officially supported authentication method.
                  </p>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <div>
                <label class="block text-sm font-medium text-gray-300 mb-2">
                  Anthropic API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onInput={(e) =>
                    setApiKey((e.target as HTMLInputElement).value)}
                  placeholder="sk-ant-..."
                  class="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <Button
                onClick={handleSaveApiKey}
                loading={savingApiKey}
                fullWidth
                disabled={!apiKey.trim()}
              >
                Save API Key
              </Button>

              <p class="text-xs text-gray-500">
                Get your API key from{" "}
                <a
                  href="https://console.anthropic.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-blue-400 hover:text-blue-300 underline"
                >
                  console.anthropic.com
                </a>
              </p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
