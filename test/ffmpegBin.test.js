import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import {
  FfmpegMissingError,
  assertFfmpegAvailable,
  resetFfmpegPathCache,
  resolveFfmpegPath,
} from '../src/ffmpegBin.js';

const execFileAsync = promisify(execFile);

describe('ffmpeg detection', () => {
  const prevFfmpegPath = process.env.FFMPEG_PATH;
  const prevFfprobePath = process.env.FFPROBE_PATH;

  beforeEach(() => {
    resetFfmpegPathCache();
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
  });

  afterEach(() => {
    resetFfmpegPathCache();
    if (prevFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpegPath;
    if (prevFfprobePath === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = prevFfprobePath;
  });

  it('resolves an absolute executable ffmpeg path from PATH', async () => {
    const path = await resolveFfmpegPath();
    assert.match(path, /ffmpeg/i);
    assert.equal(path.startsWith('/'), true, `expected absolute path, got ${path}`);
  });

  it('assertFfmpegAvailable logs a version string', async () => {
    const info = await assertFfmpegAvailable();
    assert.ok(info.ffmpegPath);
    assert.match(info.ffmpegVersion, /ffmpeg version/i);
  });

  it('honors FFMPEG_PATH when it points at a real binary', async () => {
    const resolved = await resolveFfmpegPath();
    resetFfmpegPathCache();
    process.env.FFMPEG_PATH = resolved;
    const again = await resolveFfmpegPath();
    assert.equal(again, resolved);
  });

  it('throws a clear FfmpegMissingError when FFMPEG_PATH is unusable', async () => {
    process.env.FFMPEG_PATH = '/definitely/not/a/real/ffmpeg-binary';
    await assert.rejects(
      () => resolveFfmpegPath(),
      (err) => {
        assert.equal(err instanceof FfmpegMissingError, true);
        assert.match(err.message, /FFMPEG_PATH=/);
        assert.match(err.message, /not executable/);
        return true;
      },
    );
  });

  it('npm run check:ffmpeg exits 0 when ffmpeg is installed', async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const { stdout } = await execFileAsync('npm', ['run', 'check:ffmpeg'], {
      cwd: repoRoot,
      timeout: 15000,
    });
    assert.match(stdout, /ffmpeg check: ok/);
  });
});
