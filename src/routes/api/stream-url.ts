import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPwToken } from "@/lib/hls-upstream";

const UPSTREAM_BASE = "https://www.learnxpw.site";
const PW_API = "https://api.penpencil.co";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const querySchema = z.object({
  batchId: z.string().min(1).max(128),
  subjectId: z.string().min(1).max(128),
  childId: z.string().min(1).max(128),
});

/** Extract the videoKey (first path segment) from a cloudfront mpd/m3u8 URL. */
function extractVideoKey(url: string): string | null {
  const match = url.match(/cloudfront\.net\/([0-9a-fA-F-]{8,})\//);
  return match?.[1] ?? null;
}

/** Provider 1: learnxpw Schedule API. */
async function resolveViaLearnxpw(
  batchId: string,
  subjectId: string,
  childId: string,
) {
  try {
    const res = await fetch(
      `${UPSTREAM_BASE}/api/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&ContentId=${encodeURIComponent(childId)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
          Referer: `${UPSTREAM_BASE}/`,
        },
      },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!json?.success || !json?.data) return null;
    const directUrl: string | undefined = json.data.videoUrl || json.data.url;
    const videoKey = directUrl ? extractVideoKey(directUrl) : null;
    if (!videoKey) return null;
    return {
      videoKey,
      directUrl: directUrl ?? null,
      title: json.data.title ?? json.data.slug ?? null,
      provider: "PW-MARCO",
    };
  } catch {
    return null;
  }
}

/** Provider 2: PW schedule-details with a pooled access token. */
async function resolveViaPw(
  batchId: string,
  subjectId: string,
  childId: string,
) {
  const token = await getPwToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${PW_API}/v1/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/schedule/${encodeURIComponent(childId)}/schedule-details`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "client-type": "WEB",
          "client-version": "6.0.1",
          randomId: "0",
          Origin: "https://www.pw.live",
          Referer: "https://www.pw.live/",
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const d = json?.data;
    if (!d) return null;
    const directUrl: string | undefined =
      d.videoDetails?.videoUrl ?? d.videoUrl ?? d.url;
    const videoKey = directUrl
      ? extractVideoKey(directUrl)
      : (d.videoDetails?.videoKey ?? null);
    if (!videoKey) return null;
    return {
      videoKey,
      directUrl: directUrl ?? null,
      title: d.topic ?? d.name ?? null,
      provider: "PW Direct",
    };
  } catch {
    return null;
  }
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

        const resolved =
          (await resolveViaLearnxpw(batchId, subjectId, childId)) ??
          (await resolveViaPw(batchId, subjectId, childId));

        if (!resolved) {
          return Response.json(
            { success: false, message: "Video not found for the given IDs" },
            { status: 404 },
          );
        }

        const origin = url.origin;
        const streamUrl = `${origin}/api/public/hls?p=${encodeURIComponent(`/${resolved.videoKey}/master.m3u8`)}`;

        return Response.json({
          success: true,
          videoKey: resolved.videoKey,
          // Self-hosted playlist: player never touches learnxpw directly.
          streamUrl,
          resolvedVia: resolved.provider,
          directUrl: resolved.directUrl,
          title: resolved.title,
          note: "streamUrl is served from this app's own domain (no Referer header needed). Playlists, AES keys and .ts segments are all proxied here.",
        });
      },
    },
  },
});
