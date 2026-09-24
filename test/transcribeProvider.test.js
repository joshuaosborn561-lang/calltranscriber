import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTranscribeProvider } from '../src/transcribe.js';

describe('getTranscribeProvider', () => {
  const keys = [
    'TRANSCRIBE_PROVIDER',
    'ASSEMBLYAI_API_KEY',
    'OPENAI_API_KEY',
  ];
  const prev = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('prefers assemblyai when that key is set', () => {
    process.env.ASSEMBLYAI_API_KEY = 'test-aai';
    process.env.OPENAI_API_KEY = 'test-oai';
    assert.equal(getTranscribeProvider(), 'assemblyai');
  });

  it('honors explicit TRANSCRIBE_PROVIDER=openai', () => {
    process.env.ASSEMBLYAI_API_KEY = 'test-aai';
    process.env.OPENAI_API_KEY = 'test-oai';
    process.env.TRANSCRIBE_PROVIDER = 'openai';
    assert.equal(getTranscribeProvider(), 'openai');
  });

  it('falls back to openai when only that key exists', () => {
    process.env.OPENAI_API_KEY = 'test-oai';
    assert.equal(getTranscribeProvider(), 'openai');
  });
});
