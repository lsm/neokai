import { serve } from "bun";
import index from "./index.html";

const DAEMON_URL = process.env.DAEMON_URL || "http://localhost:8283";
const PORT = process.env.PORT || 9283;
const isDev = process.env.NODE_ENV !== "production";

const server = serve({
  port: PORT,
  routes: {
    // SPA - serve index.html for all routes (client-side handling)
    "/*": index,

    // API proxy to daemon - forward all /api requests
    "/api/*": async (req) => {
      const url = new URL(req.url);
      const daemonUrl = `${DAEMON_URL}${url.pathname}${url.search}`;

      try {
        const response = await fetch(daemonUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
        });

        return response;
      } catch (error) {
        console.error("API proxy error:", error);
        return new Response(
          JSON.stringify({ error: "Failed to connect to daemon" }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    },
  },

  development: isDev && {
    hmr: true, // Hot module replacement
    console: true, // Stream browser console to terminal
  },
});

console.log(`🚀 Liuboer Web UI running on ${server.url}`);
console.log(`📡 Proxying API requests to ${DAEMON_URL}`);
console.log(`⚡ HMR: ${isDev ? "enabled" : "disabled"}`);
