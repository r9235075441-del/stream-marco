/**
 * Self-hosted HLS upstream layer.
 *
 * Goal: the player only ever talks to OUR domain. Every playlist, key and
 * segment is fetched server-side through a provider chain so that if one
 * upstream (learnxpw) disappears, the others keep the lectures alive.
 *
 * Provider chain (first success wins):
 *   1. learnxpw  -> /api/play/m3u8?path=...   (works today, no auth needed)
 *   2. PW direct -> CloudFront with a signed URL obtained from api.penpencil.co
 *                   using a pooled PW access token
 */

const LEARNXPW_BASE = "https://www.learnxpw.site";
const CLOUDFRONT_BASE = "https://d1d34p8vz63oiq.cloudfront.net";
const PW_API = "https://api.penpencil.co";

const TOKEN_SOURCES = [
  "https://pw.deltaverse.site/api/internal/tokens",
  "https://pwxmarco.pages.dev/api/token-manager.php",
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type UpstreamResult = {
  ok: boolean;
  status: number;
  body: ArrayBuffer;
  contentType: string;
  provider: string;
};

/* ------------------------------------------------------------------ */
/* PW token pool                                                       */
/* ------------------------------------------------------------------ */

let cachedToken: { token: string; exp: number } | null = null;

function jwtExp(token: string): number {
  try {
    const part = token.split(".")[1];
    if (!part) return 0;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return Number(JSON.parse(json)?.exp ?? 0);
  } catch {
    return 0;
  }
}

/** Fetch a non-expired PW access token from the public token pools. */
export async function getPwToken(): Promise<string | null> {
  const now = Date.now() / 1000;
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token;

  const envToken = process.env["PW_ACCESS_TOKEN"];
  if (envToken && jwtExp(envToken) > now + 60) {
    cachedToken = { token: envToken, exp: jwtExp(envToken) };
    return envToken;
  }

  for (const src of TOKEN_SOURCES) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(src, {
          headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
        });
        if (!res.ok) break;
        const json: any = await res.json();
        const token: string | undefined =
          json?.token?.accessToken ?? json?.accessToken;
        if (!token) break;
        const exp = jwtExp(token);
        if (exp > now + 60) {
          cachedToken = { token, exp };
          return token;
        }
      } catch {
        break;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

function contentTypeFor(path: string, fallback: string): string {
  if (path.includes(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.includes("enc.key") || path.includes("get-hls-key"))
    return "application/octet-stream";
  return fallback;
}

async function viaLearnxpw(path: string): Promise<UpstreamResult | null> {
  try {
    const res = await fetch(
      `${LEARNXPW_BASE}/api/play/m3u8?path=${encodeURIComponent(path)}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Referer: `${LEARNXPW_BASE}/`,
          Accept: "*/*",
        },
      },
    );
    if (!res.ok) return null;
    const body = await res.arrayBuffer();
    // learnxpw answers errors with a JSON body and 200 in some cases
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && body.byteLength < 512) return null;
    return {
      ok: true,
      status: 200,
      body,
      contentType: contentTypeFor(path, ct || "application/octet-stream"),
      provider: "PW-MARCO",
    };
  } catch {
    return null;
  }
}

/** Ask PW for a signed CloudFront URL / cookies for a given videoKey. */
async function pwSignedHeaders(
  videoKey: string,
): Promise<{ cookie: string } | null> {
  const token = await getPwToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `${PW_API}/v1/videos/video-url-details?videoUrl=${encodeURIComponent(
        `${CLOUDFRONT_BASE}/${videoKey}/master.mpd`,
      )}`,
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
    const d = json?.data ?? {};
    const parts = [
      d["CloudFront-Policy"] && `CloudFront-Policy=${d["CloudFront-Policy"]}`,
      d["CloudFront-Signature"] &&
        `CloudFront-Signature=${d["CloudFront-Signature"]}`,
      d["CloudFront-Key-Pair-Id"] &&
        `CloudFront-Key-Pair-Id=${d["CloudFront-Key-Pair-Id"]}`,
    ].filter(Boolean);
    if (!parts.length) return null;
    return { cookie: parts.join("; ") };
  } catch {
    return null;
  }
}

async function viaPwDirect(path: string): Promise<UpstreamResult | null> {
  const videoKey = path.replace(/^\//, "").split("/")[0];
  if (!videoKey) return null;

  // AES key requests go to the PW API, not CloudFront.
  if (path.includes("get-hls-key")) {
    const token = await getPwToken();
    if (!token) return null;
    try {
      const res = await fetch(
        `${PW_API}/v1/videos/get-hls-key?videoKey=${encodeURIComponent(videoKey)}&key=enc.key`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "client-type": "WEB",
            randomId: "0",
            "User-Agent": BROWSER_UA,
          },
        },
      );
      if (!res.ok) return null;
      return {
        ok: true,
        status: 200,
        body: await res.arrayBuffer(),
        contentType: "application/octet-stream",
        provider: "PW Direct",
      };
    } catch {
      return null;
    }
  }

  const signed = await pwSignedHeaders(videoKey);
  if (!signed) return null;
  try {
    const res = await fetch(`${CLOUDFRONT_BASE}${path}`, {
      headers: {
        Cookie: signed.cookie,
        "User-Agent": BROWSER_UA,
        Accept: "*/*",
      },
    });
    if (!res.ok) return null;
    return {
      ok: true,
      status: 200,
      body: await res.arrayBuffer(),
      contentType: contentTypeFor(
        path,
        res.headers.get("content-type") ?? "application/octet-stream",
      ),
      provider: "PW Direct",
    };
  } catch {
    return null;
  }
}

/** Fetch an upstream asset through the provider chain. */
export async function fetchUpstream(path: string): Promise<UpstreamResult> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  for (const provider of [viaLearnxpw, viaPwDirect]) {
    const result = await provider(normalized);
    if (result) return result;
  }
  return {
    ok: false,
    status: 502,
    body: new ArrayBuffer(0),
    contentType: "application/json",
    provider: "none",
  };
}

/* ------------------------------------------------------------------ */
/* Playlist rewriting                                                  */
/* ------------------------------------------------------------------ */

/** Absolute/relative upstream reference -> our own proxy path. */
export function toProxyPath(ref: string, currentPath: string): string {
  let upstream = ref;

  const learnxpwMatch = ref.match(/(?:^|\/)api\/play\/m3u8\?path=([^"'\s]+)/);
  if (learnxpwMatch?.[1]) {
    upstream = decodeURIComponent(learnxpwMatch[1]);
  } else if (ref.startsWith("http")) {
    try {
      upstream = new URL(ref).pathname;
    } catch {
      /* keep as-is */
    }
  } else if (!ref.startsWith("/")) {
    const base = currentPath.slice(0, currentPath.lastIndexOf("/"));
    upstream = `${base}/${ref}`;
  }

  return `/api/public/hls?p=${encodeURIComponent(upstream)}`;
}

/** Rewrite every URI inside an HLS playlist to point at our own domain. */
export function rewritePlaylist(text: string, currentPath: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_m, uri: string) => `URI="${toProxyPath(uri, currentPath)}"`,
        );
      }
      return toProxyPath(trimmed, currentPath);
    })
    .join("\n");
}
