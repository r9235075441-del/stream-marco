# Plan: Stream URL API

## Goal
Ek API endpoint banana hai jisme `batchId`, `subjectId`, `childId` dene par us video ka working **m3u8 stream URL** mile — waise hi jaise learnxpw.site ki website 403 error ke baad fallback karke nikalti hai.

## Traced flow (verified live)
1. `GET /api/Schedule?BatchId=..&SubjectId=..&ContentId=..` → response me `data.videoUrl` = `https://d1d34p8vz63oiq.cloudfront.net/<videoKey>/master.mpd`
2. VideoKey extract karke HLS URL banta hai: `https://www.learnxpw.site/api/play/m3u8?path=/<videoKey>/master.m3u8` (200, sab qualities 720/480/360/240 + enc.key proxy ke saath play hota hai)

## Implementation

### New file: `src/routes/api/stream-url.ts`
Server route `GET /api/stream-url`:

- Query params: `batchId`, `subjectId`, `childId` — Zod se validate (required, length bounds)
- Upstream call: `https://www.learnxpw.site/api/Schedule?BatchId=..&SubjectId=..&ContentId=..` (fetch, User-Agent browser jaisa)
- `data.videoUrl ?? data.url` se videoKey nikaalna (cloudfront URL ka pehla path segment)
- Response JSON:
```json
{
  "success": true,
  "videoKey": "cce8f51d-...",
  "streamUrl": "https://www.learnxpw.site/api/play/m3u8?path=%2F<videoKey>%2Fmaster.m3u8",
  "directUrl": "https://d1d34p8vz63oiq.cloudfront.net/<videoKey>/master.mpd",
  "title": "..."
}
```
- Error cases: missing params → 400; video nahi mila / videoUrl empty → 404; upstream down → 502. Sab `{ success:false, message }` shape me.
- Note: streamUrl play karne ke liye client ko `Referer: https://www.learnxpw.site` header bhejna pad sakta hai — response me `headers` hint include karunga.

### Test
- `stack_modern--invoke-server-function` se aapke diye hue IDs (`698ad35209494b495cfcc9c4` / `maths-255226` / `69f047937820b5ef4f04b0c2`) se call karke verify ki sahi `cce8f51d-...` wala m3u8 URL aata hai aur master playlist 200 deti hai.

## Notes
- Koi database/auth nahi — public read-only endpoint.
- Route file `createFileRoute('/api/stream-url')` ke saath, server.handlers.GET pattern me banega.
