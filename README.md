# call-transcriber

Node.js (ESM) Railway **cron job** that watches a Google Drive folder (default **Cube ACR**, including date subfolders) for call recordings, skips short misdials, transcribes new files with OpenAI, and uploads `.docx` transcripts back to Drive.

Processed-file tracking is a small JSON file in Drive (`.call-transcriber-state.json`) — no database.

## Prerequisites

- Node.js 20+
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

Optional: `DRIVE_TRANSCRIPTS_FOLDER_ID` — if blank, transcripts upload into the Cube ACR root.

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

`duration` is **milliseconds**. Recordings shorter than `MIN_DURATION_SECONDS` (default `15`) are skipped.

## 4. State file (no database)

Progress is stored in Drive as `.call-transcriber-state.json` inside the recordings root. Statuses: `pending`-like absence, `transcribing`, `done`, `error`, `skipped_short`. Files in `done`, `skipped_short`, or `transcribing` are not reprocessed.

## 5. Local run

```bash
cp .env.example .env
# fill in .env
npm install
npm start
```

## 6. Deploy to Railway as a Cron Job

1. Deploy this repo to Railway.
2. Service settings:
   - **Start Command:** `npm start`
   - **Cron Schedule:** e.g. `*/30 * * * *`
3. Copy env vars from `.env.example` into Railway Variables (prefer copying Google OAuth vars from replyhandler).
4. Keep it a cron/scheduled job, not an always-on web service.

## Project layout

```
package.json
.env.example
README.md
src/
  index.js            # entry point
  driveClient.js      # OAuth/Drive, recursive list, state file, upload
  stateStore.js       # in-memory status helpers (persisted to Drive JSON)
  openaiTranscribe.js
  docxBuilder.js
```
