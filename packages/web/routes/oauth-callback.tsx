import { define } from "../utils.ts";

export default define.page(function OAuthCallback() {

  return (
    <div class="min-h-screen bg-dark-950 flex items-center justify-center p-4">
      <div class="max-w-md w-full bg-dark-900 rounded-lg border border-dark-700 p-8">
        <div class="text-center">
          <div class="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              class="w-8 h-8 text-blue-400"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fill-rule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clip-rule="evenodd"
              />
            </svg>
          </div>
          <h2 class="text-xl font-bold text-gray-200 mb-4">
            OAuth Flow Not Supported
          </h2>
          <div class="text-left space-y-3 text-sm text-gray-400">
            <p>
              Authentication must be configured via environment variables before starting the daemon.
            </p>
            <div class="bg-dark-800 rounded-lg p-3 border border-dark-600">
              <p class="font-medium text-gray-300 mb-2">To configure authentication:</p>
              <ol class="list-decimal list-inside space-y-1">
                <li>Stop the daemon</li>
                <li>Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN environment variable</li>
                <li>Restart the daemon</li>
              </ol>
            </div>
          </div>
          <button
            onClick={() => window.location.href = "/"}
            class="mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
          >
            Return to Home
          </button>
        </div>
      </div>
    </div>
  );
});
