import {
  createDriveClient,
  listRecordingsWithMetadata,
  downloadFileBuffer,
  uploadDocx,
} from './driveClient.js';
import { transcribeAudio } from './openaiTranscribe.js';
import { buildTranscriptDocx } from './docxBuilder.js';
import {
  createSupabaseClient,
  getAlreadyProcessedDriveFileIds,
  upsertTranscriptionRow,
  markDone,
  markSkippedShort,
} from './supabaseClient.js';

function getMinDurationSeconds() {
  const raw = process.env.MIN_DURATION_SECONDS;
  const n = raw == null || raw === '' ? 15 : Number(raw);
  return Number.isFinite(n) ? n : 15;
}

function getTranscriptsFolderId() {
  const transcripts = process.env.DRIVE_TRANSCRIPTS_FOLDER_ID;
  if (transcripts && transcripts.trim()) return transcripts.trim();
  return process.env.DRIVE_RECORDINGS_FOLDER_ID;
}

function transcriptFileName(recordingName) {
  const i = recordingName.lastIndexOf('.');
  const base = i > 0 ? recordingName.slice(0, i) : recordingName;
  return `${base} - transcript.docx`;
}

async function processRecording(drive, supabase, recording, transcriptsFolderId) {
  await upsertTranscriptionRow(supabase, {
    drive_file_id: recording.id,
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'transcribing',
  });

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

  await markDone(supabase, recording.id, docxFileId);
  return docxFileId;
}

async function persistError(supabase, recording, message) {
  // Upsert so this works even when no row exists yet (e.g. bad sidecar).
  await upsertTranscriptionRow(supabase, {
    drive_file_id: recording.id,
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'error',
    error: String(message).slice(0, 4000),
    completed_at: new Date().toISOString(),
  });
}

async function main() {
  const recordingsFolderId = process.env.DRIVE_RECORDINGS_FOLDER_ID;
  if (!recordingsFolderId) {
    throw new Error('DRIVE_RECORDINGS_FOLDER_ID is required');
  }

  const minDuration = getMinDurationSeconds();
  const transcriptsFolderId = getTranscriptsFolderId();

  const drive = createDriveClient();
  const supabase = createSupabaseClient();

  const recordings = await listRecordingsWithMetadata(drive, recordingsFolderId);
  const alreadyProcessed = await getAlreadyProcessedDriveFileIds(supabase);

  let newCount = 0;
  let succeeded = 0;
  let errored = 0;
  let skippedShort = 0;

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
      try {
        await persistError(supabase, recording, message);
      } catch (persistErr) {
        console.error(
          `Failed to persist error status for ${recording.name}: ${persistErr.message}`,
        );
      }
      continue;
    }

    if (duration < minDuration) {
      try {
        await markSkippedShort(supabase, recording);
        skippedShort += 1;
        console.log(
          `Skipped short: ${recording.name} (duration=${duration}s)`,
        );
      } catch (err) {
        errored += 1;
        console.error(
          `Failed to mark skipped_short for ${recording.name}: ${err.message}`,
        );
      }
      continue;
    }

    try {
      console.log(`Transcribing: ${recording.name} (${duration}s)`);
      await processRecording(drive, supabase, recording, transcriptsFolderId);
      succeeded += 1;
      console.log(`Done: ${recording.name}`);
    } catch (err) {
      errored += 1;
      console.error(`Error processing ${recording.name}: ${err.message}`);
      try {
        await persistError(supabase, recording, err.message);
      } catch (persistErr) {
        console.error(
          `Failed to persist error status for ${recording.name}: ${persistErr.message}`,
        );
      }
    }
  }

  console.log(
    `Summary: found=${recordings.length} new=${newCount} succeeded=${succeeded} errored=${errored} skipped_short=${skippedShort}`,
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exitCode = 1;
});
