/**
 * Lightweight processed-file tracking backed by a JSON object in memory
 * (persisted to Drive by driveClient.saveState — no Supabase / DB).
 */

const SKIP_STATUSES = new Set([
  'done',
  'skipped_short',
  // skipped_long is reopenable when MAX_DURATION_SECONDS is raised / disabled.
  // skipped_backlog is NOT permanent — a rolling LOOKBACK_DAYS window can reopen
  // older files when the lookback expands.
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

/** Clear skipped_backlog so files inside the current lookback can be transcribed. */
export function clearBacklogSkips(stateData, driveFileIds) {
  let cleared = 0;
  for (const id of driveFileIds) {
    const row = stateData.files?.[id];
    if (row?.status === 'skipped_backlog') {
      delete stateData.files[id];
      cleared += 1;
    }
  }
  return cleared;
}

/** Clear skipped_long so long calls can be retried (chunked transcription). */
export function clearLongSkips(stateData, driveFileIds) {
  let cleared = 0;
  for (const id of driveFileIds) {
    const row = stateData.files?.[id];
    if (row?.status === 'skipped_long') {
      delete stateData.files[id];
      cleared += 1;
    }
  }
  return cleared;
}

const FFMPEG_MISSING_RE =
  /ffmpeg failed to start|spawn .*ffmpeg.* ENOENT|ffmpeg is not installed|not on PATH/i;

/** True when a stored error is only "ffmpeg missing" (safe to retry after deploy). */
export function isFfmpegMissingError(message) {
  return FFMPEG_MISSING_RE.test(String(message || ''));
}

/**
 * Drop error rows caused only by a missing ffmpeg binary so they reprocess.
 * `done` rows are left alone — do not duplicate existing transcripts.
 */
export function clearFfmpegMissingErrors(stateData, driveFileIds) {
  let cleared = 0;
  for (const id of driveFileIds) {
    const row = stateData.files?.[id];
    if (row?.status === 'error' && isFfmpegMissingError(row.error)) {
      delete stateData.files[id];
      cleared += 1;
    }
  }
  return cleared;
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
