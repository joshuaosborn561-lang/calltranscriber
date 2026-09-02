import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Railway Dockerfile builder', () => {
  it('forces DOCKERFILE in railway.toml and railway.json', () => {
    const toml = readFileSync(join(root, 'railway.toml'), 'utf8');
    assert.match(toml, /builder\s*=\s*"DOCKERFILE"/);
    assert.doesNotMatch(toml, /builder\s*=\s*"RAILPACK"/);

    const json = JSON.parse(readFileSync(join(root, 'railway.json'), 'utf8'));
    assert.equal(json.build.builder, 'DOCKERFILE');
    assert.equal(json.build.dockerfilePath, 'Dockerfile');
  });

  it('Dockerfile installs ffmpeg and fails the build if ffmpeg -version fails', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /apt-get install[\s\S]*ffmpeg/);
    assert.match(dockerfile, /ffmpeg -version/);
    assert.match(dockerfile, /set -eux/);
    assert.match(dockerfile, /node src\/ffmpegBin\.js/);
  });
});
