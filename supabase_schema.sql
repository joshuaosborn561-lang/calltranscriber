-- call_transcriptions: tracks which Drive recordings have been transcribed
-- so cron re-runs never reprocess the same file.

create extension if not exists "pgcrypto";

create table if not exists public.call_transcriptions (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text unique not null,
  file_name text not null,
  duration_seconds numeric,
  status text not null default 'pending'
    check (status in ('pending', 'transcribing', 'done', 'error', 'skipped_short')),
  transcript_docx_file_id text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists call_transcriptions_status_idx
  on public.call_transcriptions (status);

comment on table public.call_transcriptions is
  'Dedupes and tracks status of Google Drive call recording transcriptions.';
