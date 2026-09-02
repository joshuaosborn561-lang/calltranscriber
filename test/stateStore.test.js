import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearFfmpegMissingErrors,
  getAlreadyProcessedIds,
  isFfmpegMissingError,
} from '../src/stateStore.js';

describe('ffmpeg ENOENT requeue', () => {
  it('detects the worker spawn ENOENT message', () => {
    assert.equal(
      isFfmpegMissingError(
        'ffmpeg failed to start (spawn ffmpeg ENOENT). Install ffmpeg on the host.',
      ),
      true,
    );
    assert.equal(
      isFfmpegMissingError(
        'ffmpeg is not installed or not on PATH (PATH=/usr/bin). Cube ACR .amr recordings cannot be converted.',
      ),
      true,
    );
    assert.equal(isFfmpegMissingError('OpenAI transcription failed (429)'), false);
    assert.equal(isFfmpegMissingError('ffmpeg exited 1: Invalid data'), false);
  });

  it('clears only ffmpeg-missing errors and leaves done / other errors', () => {
    const stateData = {
      files: {
        kyle: {
          status: 'error',
          error: 'ffmpeg failed to start (spawn ffmpeg ENOENT). Install ffmpeg on the host.',
        },
        dave: {
          status: 'error',
          error: 'OpenAI transcription failed (429): insufficient_quota',
        },
        doneCall: {
          status: 'done',
          transcript_docx_file_id: 'docx-1',
          error: null,
        },
      },
    };

    const cleared = clearFfmpegMissingErrors(stateData, [
      'kyle',
      'dave',
      'doneCall',
    ]);
    assert.equal(cleared, 1);
    assert.equal(stateData.files.kyle, undefined);
    assert.equal(stateData.files.dave.status, 'error');
    assert.equal(stateData.files.doneCall.status, 'done');

    const processed = getAlreadyProcessedIds(stateData);
    assert.equal(processed.has('doneCall'), true);
    assert.equal(processed.has('kyle'), false);
    assert.equal(processed.has('dave'), false);
  });
});
