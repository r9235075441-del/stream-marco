import { createFileRoute } from "@tanstack/react-router";
import { fetchUpstream, rewritePlaylist } from "@/lib/hls-upstream";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export const Route = createFileRoute("/api/public/hls")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const p = url.searchParams.get("p");
        if (!p || p.length > 512 || !/^\/?[\w\-./?=&%]+$/.test(p)) {
          return Response.json(
            { success: false, message: "Missing or invalid `p` parameter" },
            { status: 400, headers: CORS },
          );
        }

        const result = await fetchUpstream(p);
        if (!result.ok) {
          return Response.json(
            {
              success: false,
              message: "All upstream providers failed for this asset",
            },
            { status: 502, headers: CORS },
          );
        }

        // Playlists get rewritten so every child URI stays on our domain.
        if (result.contentType.includes("mpegurl") || p.includes(".m3u8")) {
          const text = new TextDecoder().decode(result.body);
          return new Response(rewritePlaylist(text, p), {
            status: 200,
            headers: {
              ...CORS,
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "public, max-age=60",
              "X-Upstream-Provider": result.provider,
            },
          });
        }

        return new Response(result.body, {
          status: 200,
          headers: {
            ...CORS,
            "Content-Type": result.contentType,
            "Cache-Control": "public, max-age=86400",
            "X-Upstream-Provider": result.provider,
          },
        });
      },
    },
  },
});
