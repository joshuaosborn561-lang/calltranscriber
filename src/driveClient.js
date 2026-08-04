import { Readable } from 'node:stream';
import { google } from 'googleapis';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const STATE_FILE_NAME = '.call-transcriber-state.json';

/**
 * Create an authenticated Drive client.
 *
 * Preferred (OAuth, same style as replyhandler):
 *   GOOGLE_CLIENT_ID / GMAIL_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET / GMAIL_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *
 * Fallback (service account JSON blob):
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 */
export function createDriveClient() {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  const clientId = (
    process.env.GOOGLE_CLIENT_ID ||
    process.env.GMAIL_CLIENT_ID ||
    ''
  ).trim();
  const clientSecret = (
    process.env.GOOGLE_CLIENT_SECRET ||
    process.env.GMAIL_CLIENT_SECRET ||
    ''
  ).trim();

  if (refreshToken) {
    if (!clientId || !clientSecret) {
      throw new Error(
        'GOOGLE_CLIENT_ID (or GMAIL_CLIENT_ID) and matching CLIENT_SECRET are required with GOOGLE_REFRESH_TOKEN',
      );
    }
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'Set GOOGLE_REFRESH_TOKEN (+ CLIENT_ID/SECRET) or GOOGLE_SERVICE_ACCOUNT_JSON',
    );
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
 * Resolve the recordings root folder.
 * Prefer DRIVE_RECORDINGS_FOLDER_ID; otherwise search for DRIVE_RECORDINGS_FOLDER_NAME
 * (default "Cube ACR").
 */
export async function resolveRecordingsFolderId(drive) {
  const explicit = (
    process.env.DRIVE_RECORDINGS_FOLDER_ID ||
    process.env.CUBE_ACR_DRIVE_FOLDER_ID ||
    ''
  ).trim();
  if (explicit) return explicit;

  const name = (process.env.DRIVE_RECORDINGS_FOLDER_NAME || 'Cube ACR').trim();
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${escaped}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = res.data.files || [];
  if (files.length === 0) {
    throw new Error(`Could not find Drive folder named "${name}"`);
  }
  if (files.length > 1) {
    console.warn(
      `Multiple folders named "${name}" found; using the first (${files[0].id})`,
    );
  }
  return files[0].id;
}

/**
 * List all files under a folder, including nested date subfolders.
 */
async function listAllFilesRecursive(drive, rootFolderId) {
  const all = [];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift();
    let pageToken;

    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, parents)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of res.data.files || []) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          queue.push(file.id);
        } else {
          all.push(file);
        }
      }

      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  }

  return all;
}

/**
 * List recordings under the root folder (and date subfolders) with sidecar metadata.
 */
export async function listRecordingsWithMetadata(drive, folderId) {
  const extensions = getRecordingExtensions();
  const files = await listAllFilesRecursive(drive, folderId);

  // Pair by parent folder + base name so same names in different date folders don't collide.
  const byKey = new Map();
  for (const file of files) {
    const parent = (file.parents && file.parents[0]) || 'root';
    const base = baseName(file.name);
    const key = `${parent}::${base}`;
    if (!byKey.has(key)) {
      byKey.set(key, { recording: null, sidecar: null });
    }
    const entry = byKey.get(key);
    const ext = extensionOf(file.name);
    if (ext === 'json') {
      entry.sidecar = file;
    } else if (extensions.includes(ext)) {
      entry.recording = file;
    }
  }

  const results = [];

  for (const [key, { recording, sidecar }] of byKey) {
    if (!recording) continue;
    const base = key.split('::').slice(1).join('::');

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
      parentId: (recording.parents && recording.parents[0]) || folderId,
      durationSeconds,
      callee,
      direction,
      sidecarMissing,
    });
  }

  return results;
}

export async function downloadFileBuffer(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data);
}

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

/**
 * Load processed-file state from a small JSON file in Drive (no database).
 * Shape: { files: { [driveFileId]: { status, fileName, ... } } }
 */
export async function loadState(drive, folderId) {
  const existing = await findStateFile(drive, folderId);
  if (!existing) {
    return { fileId: null, data: { files: {} } };
  }

  try {
    const buf = await downloadFileBuffer(drive, existing.id);
    const data = JSON.parse(buf.toString('utf8'));
    if (!data.files || typeof data.files !== 'object') {
      return { fileId: existing.id, data: { files: {} } };
    }
    return { fileId: existing.id, data };
  } catch (err) {
    console.warn(`Could not parse state file, starting fresh: ${err.message}`);
    return { fileId: existing.id, data: { files: {} } };
  }
}

async function findStateFile(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${STATE_FILE_NAME}' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files && res.data.files[0]) || null;
}

/**
 * Persist state JSON back to Drive (create or update).
 */
export async function saveState(drive, folderId, stateFileId, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');

  if (stateFileId) {
    await drive.files.update({
      fileId: stateFileId,
      media: {
        mimeType: 'application/json',
        body: Readable.from(body),
      },
      supportsAllDrives: true,
    });
    return stateFileId;
  }

  const res = await drive.files.create({
    requestBody: {
      name: STATE_FILE_NAME,
      parents: [folderId],
      mimeType: 'application/json',
    },
    media: {
      mimeType: 'application/json',
      body: Readable.from(body),
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  return res.data.id;
}

export { STATE_FILE_NAME };
