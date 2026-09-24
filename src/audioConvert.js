import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegMissingError, resolveFfmpegPath } from './ffmpegBin.js';

/** Formats OpenAI gpt-4o-mini-transcribe accepts without conversion. */
const OPENAI_NATIVE_EXTS = new Set([
  'flac',
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'ogg',
  'wav',
  'webm',
]);

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
 * Ensure audio bytes are in an OpenAI-supported container.
 * AMR (Cube ACR default) is converted to mp3 via ffmpeg.
 *
 * @returns {{ buffer: Buffer, fileName: string, converted: boolean }}
 */
export async function ensureOpenAiAudio(fileName, audioBuffer) {
  const ext = extensionOf(fileName);
  if (OPENAI_NATIVE_EXTS.has(ext)) {
    return { buffer: audioBuffer, fileName, converted: false };
  }

  const id = randomUUID();
  const inPath = join(tmpdir(), `${id}.${ext || 'bin'}`);
  const outPath = join(tmpdir(), `${id}.mp3`);
  const outName = `${baseName(fileName)}.mp3`;

  await writeFile(inPath, audioBuffer);
  try {
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '64k',
      outPath,
    ]);
    const buffer = await readFile(outPath);
    return { buffer, fileName: outName, converted: true };
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  }
}

/**
 * Split an mp3 buffer into ~chunkSeconds pieces for long-call transcription.
 * @returns {Promise<Array<{ buffer: Buffer, fileName: string }>>}
 */
export async function splitMp3IntoChunks(
  mp3Buffer,
  baseFileName,
  chunkSeconds = 600,
) {
  const id = randomUUID();
  const dir = join(tmpdir(), `chunks-${id}`);
  const inPath = join(dir, 'input.mp3');
  await mkdir(dir, { recursive: true });
  await writeFile(inPath, mp3Buffer);

  const pattern = join(dir, 'chunk_%03d.mp3');
  try {
    await runFfmpeg([
      '-y',
      '-i',
      inPath,
      '-f',
      'segment',
      '-segment_time',
      String(chunkSeconds),
      '-reset_timestamps',
      '1',
      '-c',
      'copy',
      pattern,
    ]);

    const names = (await readdir(dir))
      .filter((n) => n.startsWith('chunk_') && n.endsWith('.mp3'))
      .sort();
    if (names.length === 0) {
      throw new Error('ffmpeg produced no audio chunks');
    }

    const stem = baseName(baseFileName);
    const chunks = [];
    for (let i = 0; i < names.length; i += 1) {
      const buffer = await readFile(join(dir, names[i]));
      chunks.push({
        buffer,
        fileName: `${stem}.part${String(i + 1).padStart(2, '0')}.mp3`,
      });
    }
    return chunks;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runFfmpeg(args) {
  const ffmpegPath = await resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new FfmpegMissingError(
            `ffmpeg failed to start (spawn ${ffmpegPath} ENOENT). ` +
              'Install ffmpeg in the deploy image and redeploy.',
          ),
        );
        return;
      }
      reject(
        new Error(
          `ffmpeg failed to start (${err.message}). Binary: ${ffmpegPath}`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `ffmpeg exited ${code}: ${stderr.split('\n').slice(-8).join(' ')}`,
          ),
        );
      }
    });
  });
}
