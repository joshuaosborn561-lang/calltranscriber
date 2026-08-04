import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(
        new Error(
          `ffmpeg failed to start (${err.message}). Install ffmpeg on the host.`,
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
