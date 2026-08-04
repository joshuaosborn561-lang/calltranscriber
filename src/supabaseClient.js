import { createClient } from '@supabase/supabase-js';

/**
 * Create a Supabase client using the service role key (server-side only).
 */
export function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL is required');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Return a Set of drive_file_id values that should not be processed again
 * (status in done, skipped_short, or transcribing).
 */
export async function getAlreadyProcessedDriveFileIds(supabase) {
  const statuses = ['done', 'skipped_short', 'transcribing'];
  const ids = new Set();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('call_transcriptions')
      .select('drive_file_id')
      .in('status', statuses)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    for (const row of data || []) {
      if (row.drive_file_id) ids.add(row.drive_file_id);
    }

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

/**
 * Upsert a row when we start processing (or skip as too short).
 */
export async function upsertTranscriptionRow(supabase, row) {
  const { data, error } = await supabase
    .from('call_transcriptions')
    .upsert(
      {
        drive_file_id: row.drive_file_id,
        file_name: row.file_name,
        duration_seconds: row.duration_seconds ?? null,
        status: row.status,
        error: row.error ?? null,
        transcript_docx_file_id: row.transcript_docx_file_id ?? null,
        completed_at: row.completed_at ?? null,
      },
      { onConflict: 'drive_file_id' },
    )
    .select()
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return data;
}

/**
 * Mark a recording as successfully transcribed.
 */
export async function markDone(supabase, driveFileId, transcriptDocxFileId) {
  const { error } = await supabase
    .from('call_transcriptions')
    .update({
      status: 'done',
      transcript_docx_file_id: transcriptDocxFileId,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq('drive_file_id', driveFileId);

  if (error) {
    throw new Error(`Supabase markDone failed: ${error.message}`);
  }
}

/**
 * Mark a recording as failed for this run.
 */
export async function markError(supabase, driveFileId, errorMessage) {
  const { error } = await supabase
    .from('call_transcriptions')
    .update({
      status: 'error',
      error: String(errorMessage).slice(0, 4000),
      completed_at: new Date().toISOString(),
    })
    .eq('drive_file_id', driveFileId);

  if (error) {
    throw new Error(`Supabase markError failed: ${error.message}`);
  }
}

/**
 * Mark a recording as skipped for being too short.
 */
export async function markSkippedShort(supabase, recording) {
  return upsertTranscriptionRow(supabase, {
    drive_file_id: recording.id,
    file_name: recording.name,
    duration_seconds: recording.durationSeconds,
    status: 'skipped_short',
    completed_at: new Date().toISOString(),
  });
}
