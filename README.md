# call-transcriber

Node.js (ESM) Railway **cron job** that watches a Google Drive folder for call recordings (default `.amr`), skips short misdials, transcribes new files with OpenAI (`gpt-4o-mini-transcribe`), builds a `.docx` transcript, uploads it back to Drive, and records progress in Supabase so re-runs never reprocess the same file.

## Prerequisites

- Node.js 20+
- A Google Cloud service account with Drive access to your folders
- A Supabase project
- An OpenAI API key
- A Railway account (for scheduled runs)

## 1. Google Cloud service account + Drive sharing

Personal Gmail Drive files are **not** visible to service accounts unless you explicitly share the folder.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable the **Google Drive API**.
3. Create a **Service Account** (IAM & Admin → Service Accounts).
4. Create a JSON key for that service account and download it.
5. Copy the entire JSON contents into the `GOOGLE_SERVICE_ACCOUNT_JSON` env var (as a string).
6. Note the service account email (e.g. `call-transcriber@my-project.iam.gserviceaccount.com`).
7. In Google Drive, share both the **recordings** folder and the **transcripts** folder with that email as **Editor**.

Set:

- `DRIVE_RECORDINGS_FOLDER_ID` — folder ID from the Drive URL (`.../folders/<ID>`)
- `DRIVE_TRANSCRIPTS_FOLDER_ID` — optional; if blank, transcripts go into the recordings folder

## 2. Supabase schema

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run [`supabase_schema.sql`](./supabase_schema.sql).
3. Set env vars:
   - `SUPABASE_URL` — Project Settings → API → Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role` key (server-only)

## 3. OpenAI API key

1. Create a key at [platform.openai.com](https://platform.openai.com/api-keys).
2. Set `OPENAI_API_KEY`.

## 4. Recording sidecars

Each recording must have a sidecar JSON file with the **same base name**:

| Recording     | Sidecar     |
| ------------- | ----------- |
| `call.amr`    | `call.json` |

Sidecar shape:

```json
{
  "duration": "71604",
  "callee": "+15551234567",
  "direction": "Outgoing"
}
```

`duration` is in **milliseconds**. Recordings shorter than `MIN_DURATION_SECONDS` (default `15`) are marked `skipped_short` and not transcribed.

Optional: `RECORDING_EXTENSIONS` — comma-separated list without dots (default `amr`).

## 5. Local run

```bash
cp .env.example .env
# fill in .env values
npm install
npm start
```

## 6. Deploy to Railway as a Cron Job

This app is a **one-shot job**, not a long-running web service. Configure it as a Railway **Cron Job**.

1. Create a new Railway project and deploy this repo (GitHub or `railway up`).
2. In the service settings:
   - **Start Command:** `npm start`
   - **Cron Schedule:** e.g. `*/30 * * * *` (every 30 minutes)
3. Add all variables from [`.env.example`](./.env.example) in the Railway Variables UI.
4. Ensure the service is a cron/scheduled job (not a always-on web service with a public port). The process should exit after printing the summary line.

Suggested schedule: every 30 minutes is a good balance between freshness and API cost.

## How a run works

1. Authenticate to Drive with the service account (`drive` scope).
2. List files in `DRIVE_RECORDINGS_FOLDER_ID` matching configured extensions.
3. Pair each recording with its sidecar `.json` for duration / callee / direction.
4. Query Supabase for `drive_file_id` values already in `done`, `skipped_short`, or `transcribing` and skip them.
5. Skip (and record as `skipped_short`) anything under `MIN_DURATION_SECONDS`.
6. Download audio → OpenAI transcription → build `.docx` → upload to Drive → mark `done`.
7. Per-file errors are caught; other files continue. Final log line summarizes counts.

## Project layout

```
package.json
.env.example
supabase_schema.sql
README.md
src/
  index.js            # entry point (npm start)
  driveClient.js      # Drive auth, list, download, upload
  openaiTranscribe.js # OpenAI multipart transcription
  docxBuilder.js      # .docx buffer from metadata + text
  supabaseClient.js   # dedupe / status tracking
```
