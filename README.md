# call-transcriber

Node.js (ESM) Railway **cron job** that watches a Google Drive folder (default **Cube ACR**, including date subfolders) for call recordings, skips short misdials, transcribes new files with OpenAI, and uploads `.docx` transcripts back to Drive.

Processed-file tracking is a small JSON file in Drive (`.call-transcriber-state.json`) — no database.

## Prerequisites

- Node.js 20+
- **ffmpeg** (converts Cube ACR `.amr` → `.mp3`; OpenAI does not accept AMR). The deploy image installs it — see below.
- Google OAuth client + refresh token with Drive access (or a service account)
- An OpenAI API key
- A Railway account (for scheduled runs)

## 1. Google Drive auth (OAuth refresh token)

This matches how apps like replyhandler typically talk to personal Drive.

You need three values from a Google Cloud OAuth **Desktop** or **Web** client that already has Drive consent:

| Env var | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token (paste once) |

A short-lived **access** token is not enough for a cron job — it expires in ~1 hour. Use a **refresh** token.

If you already authorized Drive for replyhandler on Railway, copy those three vars from that service’s Variables panel.

**Folder:** recordings live under **Cube ACR** (override with `DRIVE_RECORDINGS_FOLDER_NAME` or set `DRIVE_RECORDINGS_FOLDER_ID`). Date subfolders are scanned recursively.

By default each transcript `.docx` is uploaded into the **same date subfolder as the recording**. Set `DRIVE_TRANSCRIPTS_FOLDER_ID` only if you want a single dump folder instead.

## 2. OpenAI API key

1. Create a key at [platform.openai.com](https://platform.openai.com/api-keys).
2. Set `OPENAI_API_KEY`.

## 3. Recording sidecars

Each recording needs a sidecar JSON with the **same base name** in the same folder:

| Recording  | Sidecar    |
| ---------- | ---------- |
| `call.amr` | `call.json` |

```json
{
  "duration": "71604",
  "callee": "+15551234567",
  "direction": "Outgoing"
}
```

`duration` is **milliseconds**. Only calls **longer than 2 minutes** and **shorter than 30 minutes** are transcribed (`MIN_DURATION_SECONDS=120`, `MAX_DURATION_SECONDS=1800`).

By default the worker only backfills / watches the **last 3 days** (`LOOKBACK_DAYS=3`). Older Cube ACR history is skipped. Newest recordings are processed first. Calls shorter than 2 minutes are skipped; there is **no max duration** by default — long calls are split into ~10 minute chunks for OpenAI.

## 4. State file (no database)

Progress is stored in Drive as `.call-transcriber-state.json` inside the recordings root. Statuses: `transcribing`, `done`, `error`, `skipped_short`, `skipped_long`, `skipped_backlog`. Files in `done` / `skipped_*` are not reprocessed. Rows with `status=error` whose message is a missing-ffmpeg / `spawn ffmpeg ENOENT` failure are cleared on the next poll after ffmpeg is available, and an existing `… - transcript.docx` in the same folder is reused (no duplicate upload).

## 5. Local run

```bash
cp .env.example .env
# fill in .env
npm install
# ffmpeg must be on PATH (apt/brew). This is what Railway runs at container start:
npm run check:ffmpeg
npm test
npm start
```

## 6. Deploy to Railway as an always-on worker

ffmpeg **must** be in the runtime image. A fresh deploy without it fails immediately (`ffmpeg is not installed or not on PATH`) instead of writing `spawn ffmpeg ENOENT` onto every long call.

The repo installs ffmpeg for every Railway builder this service has used:

| Builder | How ffmpeg is installed |
| --- | --- |
| **Railpack** (current `railway.toml` default) | `railpack.json` → `deploy.aptPackages` includes `ffmpeg` |
| Nixpacks | `nixpacks.toml` → `nixPkgs = ["...", "ffmpeg"]` |
| Dockerfile | `Dockerfile` `apt-get install ffmpeg` (switch **Builder** to Dockerfile if you want this path) |

**Redeploy after merging this change.** Railway does not pick up `railpack.json` / `nixpacks.toml` / `Dockerfile` until a new build. In the service: **Deploy → Redeploy** (or push to the connected branch). Confirm the build log installs `ffmpeg`, then the start log should print `ffmpeg: /usr/bin/ffmpeg (ffmpeg version …)`.

Optional dashboard belt-and-suspenders (not required if `railpack.json` is used): set `RAILPACK_DEPLOY_APT_PACKAGES=... ffmpeg`.

1. Deploy this repo to Railway.
2. Service settings:
   - **Start Command:** `npm start`
   - **No cron schedule** — polls Drive every `POLL_INTERVAL_SECONDS` (default **30**) aiming for transcripts within about **60 seconds** after Cube ACR uploads the file
   - Restart policy: on failure
3. Copy env vars from `.env.example` into Railway Variables (prefer copying Google OAuth vars from replyhandler).
4. After the ffmpeg-enabled deploy, errored Kyle / Dave / etc. ENOENT rows requeue automatically. Do **not** delete their Drive recordings or existing `done` transcripts.

## Project layout

```
package.json
railpack.json         # Railway Railpack: apt-install ffmpeg at runtime
nixpacks.toml         # Nixpacks fallback
Dockerfile            # optional explicit image
.env.example
README.md
src/
  index.js            # entry point / continuous poller
  ffmpegBin.js        # resolve + startup check (npm run check:ffmpeg)
  driveClient.js      # OAuth/Drive, recursive list, state file, upload
  stateStore.js       # in-memory status helpers (persisted to Drive JSON)
  audioConvert.js     # AMR→MP3 + long-call chunking
  openaiTranscribe.js
  docxBuilder.js
```
