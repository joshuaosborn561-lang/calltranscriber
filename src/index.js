import {
  createDriveClient,
  resolveRecordingsFolderId,
  listRecordingsWithMetadata,
  downloadFileBuffer,
  uploadDocx,
  loadState,
  saveState,
} from './driveClient.js';
import { transcribeAudio } from './openaiTranscribe.js';
import { buildTranscriptDocx } from './docxBuilder.js';
import {
  getAlreadyProcessedIds,
  markTranscribing,
  markDone,
  markError,
  markSkippedShort,
  markSkippedLong,
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

/** Optional cap so a first cron run doesn't burn through the whole backlog. */
function getMaxFilesPerRun() {
  const raw = process.env.MAX_FILES_PER_RUN;
  if (raw == null || raw === '') return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function getTranscriptsFolderId(recordingsFolderId) {
  const transcripts = process.env.DRIVE_TRANSCRIPTS_FOLDER_ID;
  if (transcripts && transcripts.trim()) return transcripts.trim();
  return recordingsFolderId;
}

function transcriptFileName(recordingName) {
  const i = recordingName.lastIndexOf('.');
  const base = i > 0 ? recordingName.slice(0, i) : recordingName;
  return `${base} - transcript.docx`;
}

async function processRecording(drive, recording, transcriptsFolderId, stateData) {
  const audioBuffer = await downloadFileBuffer(drive, recording.id);
  const transcriptText = await transcribeAudio(recording.name, audioBuffer);

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

  const docxFileId = await uploadDocx(
    drive,
    transcriptsFolderId,
    transcriptFileName(recording.name),
    docxBuffer,
  );

  markDone(stateData, recording, docxFileId);
  return docxFileId;
}

async function main() {
  const minDuration = getMinDurationSeconds();
  const maxDuration = getMaxDurationSeconds();
  const maxFilesPerRun = getMaxFilesPerRun();

  const drive = createDriveClient();
  const recordingsFolderId = await resolveRecordingsFolderId(drive);
  const transcriptsFolderId = getTranscriptsFolderId(recordingsFolderId);

  console.log(`Recordings folder: ${recordingsFolderId}`);
  console.log(`Transcripts folder: ${transcriptsFolderId}`);
  console.log(
    `Duration window: >${minDuration}s and <${maxDuration}s`,
  );
  if (Number.isFinite(maxFilesPerRun)) {
    console.log(`MAX_FILES_PER_RUN=${maxFilesPerRun}`);
  }

  const { fileId: initialStateFileId, data: stateData } = await loadState(
    drive,
    recordingsFolderId,
  );
  let stateFileId = initialStateFileId;

  const recordings = await listRecordingsWithMetadata(drive, recordingsFolderId);
  const alreadyProcessed = getAlreadyProcessedIds(stateData);

  let newCount = 0;
  let succeeded = 0;
  let errored = 0;
  let skippedShort = 0;
  let skippedLong = 0;
  let stateDirty = false;
  let attempted = 0;

  async function flushState() {
    stateFileId = await saveState(drive, recordingsFolderId, stateFileId, stateData);
    stateDirty = false;
  }

  for (const recording of recordings) {
    if (alreadyProcessed.has(recording.id)) {
      continue;
    }

    newCount += 1;

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
      // Persist "transcribing" before the long OpenAI call so a crash mid-run won't double-process.
      markTranscribing(stateData, recording);
      stateDirty = true;
      await flushState();

      await processRecording(drive, recording, transcriptsFolderId, stateData);
      succeeded += 1;
      stateDirty = true;
      console.log(`Done: ${recording.name}`);
    } catch (err) {
      errored += 1;
      console.error(`Error processing ${recording.name}: ${err.message}`);
      markError(stateData, recording, err.message);
      stateDirty = true;
    }

    // Save after each file so progress survives a later failure in the same run.
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
    `Summary: found=${recordings.length} new=${newCount} succeeded=${succeeded} errored=${errored} skipped_short=${skippedShort} skipped_long=${skippedLong}`,
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
