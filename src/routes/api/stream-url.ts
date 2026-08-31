import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const UPSTREAM_BASE = "https://www.learnxpw.site";

const querySchema = z.object({
  batchId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  childId: z.string().min(1).max(128),
});

/** Extract the videoKey (first path segment) from a cloudfront mpd/m3u8 URL. */
function extractVideoKey(url: string): string | null {
  const match = url.match(/cloudfront\.net\/([0-9a-fA-F-]{8,})\//);
  return match ? match[1] : null;
}

export const Route = createFileRoute("/api/stream-url")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const parsed = querySchema.safeParse({
          batchId: url.searchParams.get("batchId"),
          subjectId: url.searchParams.get("subjectId"),
          childId: url.searchParams.get("childId"),
        });
        if (!parsed.success) {
          return Response.json(
            {
              success: false,
              message:
                "Missing or invalid params. Required: batchId, subjectId, childId",
            },
            { status: 400 },
          );
        }

        const { batchId, subjectId, childId } = parsed.data;

        let schedule: any;
        try {
          const upstream = await fetch(
            `${UPSTREAM_BASE}/api/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&ContentId=${encodeURIComponent(childId)}`,
            {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                Accept: "application/json",
                Referer: `${UPSTREAM_BASE}/`,
              },
            },
          );
          if (!upstream.ok) {
            return Response.json(
              {
                success: false,
                message: `Upstream Schedule API failed with status ${upstream.status}`,
              },
              { status: 502 },
            );
          }
          schedule = await upstream.json();
        } catch {
          return Response.json(
            { success: false, message: "Failed to reach upstream server" },
            { status: 502 },
          );
        }

        if (!schedule?.success || !schedule?.data) {
          return Response.json(
            { success: false, message: "Video not found for the given IDs" },
            { status: 404 },
          );
        }

        const directUrl: string | undefined =
          schedule.data.videoUrl || schedule.data.url;
        const videoKey = directUrl ? extractVideoKey(directUrl) : null;

        if (!videoKey) {
          return Response.json(
            {
              success: false,
              message: "No video URL found in schedule data for this content",
            },
            { status: 404 },
          );
        }

        const streamUrl = `${UPSTREAM_BASE}/api/play/m3u8?path=${encodeURIComponent(`/${videoKey}/master.m3u8`)}`;

        return Response.json({
          success: true,
          videoKey,
          streamUrl,
          directUrl: directUrl ?? null,
          title: schedule.data.title ?? schedule.data.slug ?? null,
          note: "Play streamUrl with header Referer: https://www.learnxpw.site (HLS player / VLC).",
        });
      },
    },
  },
});
