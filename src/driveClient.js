import { Readable } from 'node:stream';
import { google } from 'googleapis';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * Authenticate with a Google service account JSON from env and return a Drive client.
 */
export function createDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [DRIVE_SCOPE],
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Parse RECORDING_EXTENSIONS env (comma-separated, no dots) into a normalized list.
 */
export function getRecordingExtensions() {
  const raw = process.env.RECORDING_EXTENSIONS || 'amr';
  return raw
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

function extensionOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return name;
  return name.slice(0, i);
}

/**
 * List recording files in the folder and attach sidecar metadata when present.
 * Returns items shaped like:
 * { id, name, mimeType, createdTime, durationSeconds, callee, direction, sidecarMissing }
 */
export async function listRecordingsWithMetadata(drive, folderId) {
  if (!folderId) {
    throw new Error('DRIVE_RECORDINGS_FOLDER_ID is required');
  }

  const extensions = getRecordingExtensions();
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  const byBase = new Map();
  for (const file of files) {
    const base = baseName(file.name);
    if (!byBase.has(base)) {
      byBase.set(base, { recording: null, sidecar: null });
    }
    const entry = byBase.get(base);
    const ext = extensionOf(file.name);
    if (ext === 'json') {
      entry.sidecar = file;
    } else if (extensions.includes(ext)) {
      entry.recording = file;
    }
  }

  const results = [];

  for (const [base, { recording, sidecar }] of byBase) {
    if (!recording) continue;

    let durationSeconds = null;
    let callee = null;
    let direction = null;
    let sidecarMissing = !sidecar;

    if (sidecar) {
      try {
        const buf = await downloadFileBuffer(drive, sidecar.id);
        const meta = JSON.parse(buf.toString('utf8'));
        const durationMs = Number(meta.duration);
        durationSeconds = Number.isFinite(durationMs) ? durationMs / 1000 : null;
        callee = meta.callee ?? null;
        direction = meta.direction ?? null;
      } catch (err) {
        console.warn(
          `Failed to read sidecar for ${recording.name} (${base}.json): ${err.message}`,
        );
        sidecarMissing = true;
      }
    }

    results.push({
      id: recording.id,
      name: recording.name,
      mimeType: recording.mimeType,
      createdTime: recording.createdTime,
      durationSeconds,
      callee,
      direction,
      sidecarMissing,
    });
  }

  return results;
}

/**
 * Download a Drive file's bytes into a Buffer.
 */
export async function downloadFileBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data);
}

/**
 * Upload a .docx buffer to the transcripts folder. Returns the new file id.
 */
export async function uploadDocx(drive, folderId, fileName, buffer) {
  if (!folderId) {
    throw new Error('Transcripts folder id is required for upload');
  }

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    media: {
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      body: Readable.from(buffer),
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  return res.data.id;
}
