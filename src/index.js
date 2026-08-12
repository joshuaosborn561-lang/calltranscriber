import {
  createDriveClient,
  resolveRecordingsFolderId,
  listRecordingsWithMetadata,
  downloadFileBuffer,
  uploadDocx,
  moveFileToFolder,
  loadState,
  saveState,
} from './driveClient.js';
import { OpenAIQuotaError, transcribeAudio } from './openaiTranscribe.js';
import { ensureOpenAiAudio } from './audioConvert.js';
import { buildTranscriptDocx } from './docxBuilder.js';
import {
  getAlreadyProcessedIds,
  clearBacklogSkips,
  markTranscribing,
  markDone,
  markError,
  markSkippedShort,
  markSkippedLong,
  markSkippedBacklog,
} from './stateStore.js';

/** Default 120s — only transcribe calls longer than 2 minutes. */
function getMinDurationSeconds() {
  const raw = process.env.MIN_DURATION_SECONDS;
  const n = raw == null || raw === '' ? 120 : Number(raw);
  return Number.isFinite(n) ? n : 120;
}

/** Default 1800s — skip calls 30 minutes or longer. */
function getMaxDurationSeconds() {
  const raw = process.env.MAX_DURATION_SECONDS;
  const n = raw == null || raw === '' ? 1800 : Number(raw);
  return Number.isFinite(n) ? n : 1800;
}

/** Optional cap so one poll cycle doesn't run forever. */
function getMaxFilesPerRun() {
  const raw = process.env.MAX_FILES_PER_RUN;
  if (raw == null || raw === '') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * Continuous poll interval in seconds. Default 30 (target ~60s after call drops).
 * Set POLL_INTERVAL_SECONDS=0 for a one-shot run (legacy cron mode).
 */
function getPollIntervalMs() {
  const raw = process.env.POLL_INTERVAL_SECONDS;
  const n = raw == null || raw === '' ? 30 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(15, n) * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rolling lookback window. Default: last 3 days.
 * Optional PROCESS_CREATED_AFTER can raise the floor further.
 */
function getProcessCreatedAfter() {
  const lookbackRaw = process.env.LOOKBACK_DAYS;
  const lookbackDays =
    lookbackRaw == null || lookbackRaw === ''
      ? 3
      : Number(lookbackRaw);
  const lookbackMs =
    Number.isFinite(lookbackDays) && lookbackDays > 0
      ? lookbackDays * 24 * 60 * 60 * 1000
      : 3 * 24 * 60 * 60 * 1000;
  let cutoff = new Date(Date.now() - lookbackMs);

  const raw = process.env.PROCESS_CREATED_AFTER?.trim();
  if (raw) {
    const absolute = new Date(raw);
    if (Number.isNaN(absolute.getTime())) {
      throw new Error(`PROCESS_CREATED_AFTER is not a valid date: ${raw}`);
    }
    if (absolute > cutoff) cutoff = absolute;
  }

  return cutoff;
}

/**
 * Where to put the transcript.
 * Default: same Drive folder as the recording (the date subfolder).
 * Override with DRIVE_TRANSCRIPTS_FOLDER_ID only if you want a single dump folder.
 */
function resolveTranscriptFolderId(recording, recordingsFolderId) {
  const override = process.env.DRIVE_TRANSCRIPTS_FOLDER_ID?.trim();
  if (override) return override;
  return recording.parentId || recordingsFolderId;
}

function transcriptFileName(recordingName) {
  const i = recordingName.lastIndexOf('.');
  const base = i > 0 ? recordingName.slice(0, i) : recordingName;
  return `${base} - transcript.docx`;
}

async function processRecording(drive, recording, recordingsFolderId, stateData) {
  const audioBuffer = await downloadFileBuffer(drive, recording.id);
  const prepared = await ensureOpenAiAudio(recording.name, audioBuffer);
  if (prepared.converted) {
    console.log(`Converted ${recording.name} → ${prepared.fileName} for OpenAI`);
  }
  const transcriptText = await transcribeAudio(prepared.fileName, prepared.buffer, {
    durationSeconds: recording.durationSeconds,
  });

  const docxBuffer = await buildTranscriptDocx(
    {
      fileName: recording.name,
      callee: recording.callee,
      direction: recording.direction,
      durationSeconds: recording.durationSeconds,
      recordedAt: recording.createdTime,
    },
    transcriptText,
  );

  const folderId = resolveTranscriptFolderId(recording, recordingsFolderId);
  const docxFileId = await uploadDocx(
    drive,
    folderId,
    transcriptFileName(recording.name),
    docxBuffer,
  );

  markDone(stateData, recording, docxFileId);
  return docxFileId;
}

/** Move already-done transcripts into the same folder as their recording. */
async function colocateExistingTranscripts(drive, recordings, stateData, recordingsFolderId) {
  if (process.env.DRIVE_TRANSCRIPTS_FOLDER_ID?.trim()) {
    return 0;
  }

  const byId = new Map(recordings.map((r) => [r.id, r]));
  let moved = 0;

  for (const [driveFileId, row] of Object.entries(stateData.files || {})) {
    if (row.status !== 'done' || !row.transcript_docx_file_id) continue;
    const recording = byId.get(driveFileId);
    if (!recording?.parentId) continue;

    try {
      const meta = await drive.files.get({
        fileId: row.transcript_docx_file_id,
        fields: 'id, parents, trashed',
        supportsAllDrives: true,
      });
      if (meta.data.trashed) continue;
      const parents = meta.data.parents || [];
      if (parents.includes(recording.parentId)) continue;

      await moveFileToFolder(
        drive,
        row.transcript_docx_file_id,
        recording.parentId,
      );
      moved += 1;
      console.log(
        `Moved transcript next to recording: ${row.file_name || driveFileId}`,
      );
    } catch (err) {
      console.warn(
        `Could not move transcript for ${row.file_name || driveFileId}: ${err.message}`,
      );
    }
  }

  return moved;
}

async function runOnce({ colocate = false } = {}) {
  const minDuration = getMinDurationSeconds();
  const maxDuration = getMaxDurationSeconds();
  const maxFilesPerRun = getMaxFilesPerRun();
  const processCreatedAfter = getProcessCreatedAfter();

  const drive = createDriveClient();
  const recordingsFolderId = await resolveRecordingsFolderId(drive);

  console.log(`Recordings folder: ${recordingsFolderId}`);
  console.log(
    process.env.DRIVE_TRANSCRIPTS_FOLDER_ID?.trim()
      ? `Transcripts folder override: ${process.env.DRIVE_TRANSCRIPTS_FOLDER_ID.trim()}`
      : 'Transcripts folder: same folder as each recording',
  );
  console.log(
    `Duration window: >${minDuration}s and <${maxDuration}s`,
  );
  console.log(`Backfill window: after ${processCreatedAfter.toISOString()} (LOOKBACK_DAYS)`);
  if (Number.isFinite(maxFilesPerRun)) {
    console.log(`MAX_FILES_PER_RUN=${maxFilesPerRun}`);
  }

  const { fileId: initialStateFileId, data: stateData } = await loadState(
    drive,
    recordingsFolderId,
  );
  let stateFileId = initialStateFileId;

  const recordings = await listRecordingsWithMetadata(drive, recordingsFolderId);
  // Newest first — a just-dropped call should be transcribed before older backlog.
  recordings.sort((a, b) => {
    const at = new Date(a.createdTime || 0).getTime();
    const bt = new Date(b.createdTime || 0).getTime();
    return bt - at;
  });

  if (colocate) {
    const moved = await colocateExistingTranscripts(
      drive,
      recordings,
      stateData,
      recordingsFolderId,
    );
    if (moved > 0) {
      console.log(`Colocated ${moved} existing transcript(s) with their recordings`);
    }
  }

  // Re-open anything previously marked skipped_backlog that now falls inside the window.
  const inWindowIds = recordings
    .filter(
      (r) =>
        r.createdTime && new Date(r.createdTime) >= processCreatedAfter,
    )
    .map((r) => r.id);
  const cleared = clearBacklogSkips(stateData, inWindowIds);
  if (cleared > 0) {
    console.log(`Reopened ${cleared} previously skipped_backlog file(s) in lookback window`);
    stateFileId = await saveState(drive, recordingsFolderId, stateFileId, stateData);
  }

  const alreadyProcessed = getAlreadyProcessedIds(stateData);

  let newCount = 0;
  let succeeded = 0;
  let errored = 0;
  let skippedShort = 0;
  let skippedLong = 0;
  let skippedBacklog = 0;
  let stateDirty = false;
  let attempted = 0;
  let stoppedForQuota = false;

  async function flushState() {
    stateFileId = await saveState(drive, recordingsFolderId, stateFileId, stateData);
    stateDirty = false;
  }

  for (const recording of recordings) {
    if (alreadyProcessed.has(recording.id)) {
      continue;
    }

    newCount += 1;

    if (
      !recording.createdTime ||
      new Date(recording.createdTime) < processCreatedAfter
    ) {
      markSkippedBacklog(stateData, recording);
      skippedBacklog += 1;
      stateDirty = true;
      continue;
    }

    const duration = recording.durationSeconds;
    if (duration == null) {
      const message = recording.sidecarMissing
        ? 'Missing or unreadable sidecar JSON (duration unknown)'
        : 'Sidecar duration missing or invalid';
      errored += 1;
      console.error(`Error processing ${recording.name}: ${message}`);
      markError(stateData, recording, message);
      stateDirty = true;
      continue;
    }

    // longer than 2 min, shorter than 30 min (defaults)
    if (duration <= minDuration) {
      markSkippedShort(stateData, recording);
      skippedShort += 1;
      stateDirty = true;
      console.log(`Skipped short: ${recording.name} (duration=${duration}s)`);
      continue;
    }

    if (duration >= maxDuration) {
      markSkippedLong(stateData, recording);
      skippedLong += 1;
      stateDirty = true;
      console.log(`Skipped long: ${recording.name} (duration=${duration}s)`);
      continue;
    }

    if (attempted >= maxFilesPerRun) {
      continue;
    }
    attempted += 1;

    try {
      console.log(`Transcribing: ${recording.name} (${duration}s)`);
      markTranscribing(stateData, recording);
      stateDirty = true;
      await flushState();

      await processRecording(drive, recording, recordingsFolderId, stateData);
      succeeded += 1;
      stateDirty = true;
      console.log(`Done: ${recording.name}`);
    } catch (err) {
      errored += 1;
      console.error(`Error processing ${recording.name}: ${err.message}`);
      markError(stateData, recording, err.message);
      stateDirty = true;

      if (err instanceof OpenAIQuotaError) {
        stoppedForQuota = true;
        console.error(
          'OpenAI credits exhausted — stopping this cycle. Will retry on next poll.',
        );
        try {
          await flushState();
        } catch (saveErr) {
          console.error(`Failed to save state file: ${saveErr.message}`);
        }
        break;
      }
    }

    if (stateDirty) {
      try {
        await flushState();
      } catch (saveErr) {
        console.error(`Failed to save state file: ${saveErr.message}`);
      }
    }
  }

  if (stateDirty) {
    try {
      await flushState();
    } catch (saveErr) {
      console.error(`Failed to save final state file: ${saveErr.message}`);
    }
  }

  console.log(
    `Summary: found=${recordings.length} new=${newCount} succeeded=${succeeded} errored=${errored} skipped_short=${skippedShort} skipped_long=${skippedLong} skipped_backlog=${skippedBacklog}${stoppedForQuota ? ' stopped_for_quota=1' : ''}`,
  );
}

async function main() {
  const pollMs = getPollIntervalMs();
  if (!pollMs) {
    await runOnce({ colocate: true });
    return;
  }

  console.log(
    `Continuous poller every ${pollMs / 1000}s (target: transcript ~60s after call lands in Drive)`,
  );
  let first = true;
  for (;;) {
    try {
      await runOnce({ colocate: first });
      first = false;
    } catch (err) {
      console.error(`Poll cycle error: ${err.message}`);
    }
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
