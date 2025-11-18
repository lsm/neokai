import { define } from "../utils.ts";
import { useEffect, useState } from "preact/hooks";
import { apiClient } from "../lib/api-client.ts";

export default define.page(function OAuthCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    handleOAuthCallback();
  }, []);

  const handleOAuthCallback = async () => {
    try {
      // Parse URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get("code");
      const state = urlParams.get("state");

      if (!code || !state) {
        setStatus("error");
        setMessage("Missing authorization code or state");
        return;
      }

      // Complete OAuth flow
      const response = await apiClient.completeOAuthFlow({ code, state });

      if (response.success) {
        setStatus("success");
        setMessage("Authentication successful! You can close this window.");

        // Close popup after 2 seconds if it's a popup
        if (window.opener) {
          setTimeout(() => {
            window.close();
          }, 2000);
        } else {
          // Redirect to home if not a popup
          setTimeout(() => {
            window.location.href = "/";
          }, 2000);
        }
      } else {
        setStatus("error");
        setMessage("Authentication failed");
      }
    } catch (error) {
      console.error("OAuth callback error:", error);
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Authentication failed"
      );
    }
  };

  return (
    <div class="min-h-screen bg-dark-950 flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-dark-900 rounded-lg border border-dark-700 p-8">
        {status === "loading" && (
          <div class="text-center">
            <div class="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4" />
            <h2 class="text-xl font-bold text-gray-200 mb-2">
              Completing Authentication...
            </h2>
            <p class="text-gray-400 text-sm">Please wait</p>
          </div>
        )}

        {status === "success" && (
          <div class="text-center">
            <div class="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                class="w-8 h-8 text-green-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 class="text-xl font-bold text-gray-200 mb-2">
              Authentication Successful!
            </h2>
            <p class="text-gray-400 text-sm">{message}</p>
          </div>
        )}

        {status === "error" && (
          <div class="text-center">
            <div class="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                class="w-8 h-8 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h2 class="text-xl font-bold text-gray-200 mb-2">
              Authentication Failed
            </h2>
            <p class="text-gray-400 text-sm mb-4">{message}</p>
            <button
              onClick={() => window.location.href = "/"}
              class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              Return to Home
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
