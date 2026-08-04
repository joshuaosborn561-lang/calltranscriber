/**
 * Lightweight processed-file tracking backed by a JSON object in memory
 * (persisted to Drive by driveClient.saveState — no Supabase / DB).
 */

const SKIP_STATUSES = new Set([
  'done',
  'skipped_short',
  'skipped_long',
  'skipped_backlog',
  // "transcribing" is intentionally NOT skipped forever — a crashed run can leave
  // that status; the next cron should retry it.
]);

export function getAlreadyProcessedIds(stateData) {
  const ids = new Set();
  for (const [id, row] of Object.entries(stateData.files || {})) {
    if (row && SKIP_STATUSES.has(row.status)) {
      ids.add(id);
    }
  }
  return ids;
}

export function setFileState(stateData, driveFileId, patch) {
  const prev = stateData.files[driveFileId] || {};
  stateData.files[driveFileId] = {
    ...prev,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  return stateData.files[driveFileId];
}

export function markTranscribing(stateData, recording) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'transcribing',
    error: null,
  });
}

export function markDone(stateData, recording, transcriptDocxFileId) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'done',
    transcript_docx_file_id: transcriptDocxFileId,
    error: null,
    completed_at: new Date().toISOString(),
  });
}

export function markError(stateData, recording, errorMessage) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'error',
    error: String(errorMessage).slice(0, 4000),
    completed_at: new Date().toISOString(),
  });
}

export function markSkippedShort(stateData, recording) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'skipped_short',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

export function markSkippedLong(stateData, recording) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'skipped_long',
    error: null,
    completed_at: new Date().toISOString(),
  });
}

/** Older recordings left alone so the job only watches new call drops. */
export function markSkippedBacklog(stateData, recording) {
  return setFileState(stateData, recording.id, {
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'skipped_backlog',
    error: null,
    completed_at: new Date().toISOString(),
  });
}
