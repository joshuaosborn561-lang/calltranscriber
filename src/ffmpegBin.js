import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FfmpegMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FfmpegMissingError';
  }
}

const FFMPEG_FALLBACKS = [
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/nix/var/nix/profiles/default/bin/ffmpeg',
];

const FFPROBE_FALLBACKS = [
  '/usr/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/nix/var/nix/profiles/default/bin/ffprobe',
];

let cachedFfmpegPath;
let cachedFfprobePath;

export function resetFfmpegPathCache() {
  cachedFfmpegPath = undefined;
  cachedFfprobePath = undefined;
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function which(name) {
  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 5000 });
    return stdout.trim().split('\n')[0] || '';
  } catch {
    return '';
  }
}

async function resolveOnPath(name, envKey, fallbacks) {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) {
    if (await isExecutable(fromEnv)) return fromEnv;
    throw new FfmpegMissingError(
      `${envKey}=${fromEnv} is set but that path is not executable. ` +
        `Install ffmpeg (and ffprobe) in the deploy image, or point ${envKey} at a real binary.`,
    );
  }

  const fromWhich = await which(name);
  if (fromWhich && (await isExecutable(fromWhich))) return fromWhich;

  for (const candidate of fallbacks) {
    if (await isExecutable(candidate)) return candidate;
  }

  return '';
}

/**
 * Resolve an absolute ffmpeg path (FFMPEG_PATH, `which ffmpeg`, then common locations).
 */
export async function resolveFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  const resolved = await resolveOnPath('ffmpeg', 'FFMPEG_PATH', FFMPEG_FALLBACKS);
  if (!resolved) {
    throw new FfmpegMissingError(
      `ffmpeg is not installed or not on PATH (PATH=${process.env.PATH || ''}). ` +
        'Cube ACR .amr recordings cannot be converted. ' +
        'The Railway image must be built from Dockerfile (apt-get install ffmpeg). Redeploy with a new build, not a restart.',
    );
  }
  cachedFfmpegPath = resolved;
  return resolved;
}

/**
 * Resolve ffprobe if present. Optional — duration comes from Cube ACR sidecars.
 */
export async function resolveFfprobePath() {
  if (cachedFfprobePath) return cachedFfprobePath;
  try {
    const resolved = await resolveOnPath(
      'ffprobe',
      'FFPROBE_PATH',
      FFPROBE_FALLBACKS,
    );
    if (resolved) {
      cachedFfprobePath = resolved;
      return resolved;
    }
  } catch (err) {
    if (!(err instanceof FfmpegMissingError)) throw err;
  }
  return '';
}

export async function getBinaryVersion(binPath) {
  const { stdout, stderr } = await execFileAsync(binPath, ['-version'], {
    timeout: 8000,
  });
  const line = `${stdout}\n${stderr}`.split('\n').find((l) => l.trim());
  return (line || '').trim();
}

/**
 * Fail fast if ffmpeg cannot be spawned. Logs the absolute path and version.
 * @returns {{ ffmpegPath: string, ffprobePath: string, ffmpegVersion: string }}
 */
export async function assertFfmpegAvailable() {
  const ffmpegPath = await resolveFfmpegPath();
  let ffmpegVersion = '';
  try {
    ffmpegVersion = await getBinaryVersion(ffmpegPath);
  } catch (err) {
    throw new FfmpegMissingError(
      `ffmpeg at ${ffmpegPath} failed -version (${err.message})`,
    );
  }

  const ffprobePath = await resolveFfprobePath();
  if (ffprobePath) {
    console.log(`ffprobe: ${ffprobePath}`);
  } else {
    console.warn(
      'ffprobe not found on PATH (optional; call duration comes from sidecar JSON)',
    );
  }
  console.log(`ffmpeg: ${ffmpegPath}${ffmpegVersion ? ` (${ffmpegVersion})` : ''}`);
  return { ffmpegPath, ffprobePath, ffmpegVersion };
}

async function runCheckCli() {
  try {
    const info = await assertFfmpegAvailable();
    console.log('ffmpeg check: ok');
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error(`ffmpeg check: FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await runCheckCli();
}
