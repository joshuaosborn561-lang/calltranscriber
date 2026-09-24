import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEAKER_LABELS_VERSION,
  contactNameFromRecording,
  countSpeakerLabels,
  countSpeakerLabelsInDocx,
  formatUtterances,
  getSpeakerConstraints,
  speakerIdentificationNames,
  splitSpeakerTurns,
  transcriptHasMultipleSpeakers,
  uniqueSpeakerLabels,
} from '../src/speakers.js';
import { buildTranscriptRequest } from '../src/assemblyaiTranscribe.js';
import { buildTranscriptDocx, transcriptToParagraphs } from '../src/docxBuilder.js';
import {
  clearStaleSpeakerTranscripts,
  getAlreadyProcessedIds,
  needsSpeakerRelabel,
} from '../src/stateStore.js';

describe('contactNameFromRecording', () => {
  it('pulls the Cube ACR contact name', () => {
    assert.equal(
      contactNameFromRecording(
        'Cayden (+1 561-225-5142) ↗ (phone) 2026-09-23 13-30-56.amr',
      ),
      'Cayden',
    );
    assert.equal(
      contactNameFromRecording(
        'Mike Trpkosh (+1 940-703-2097) ↗ (phone) 2026-09-23 14-28-14.amr',
      ),
      'Mike Trpkosh',
    );
  });

  it('returns null when there is no leading name', () => {
    assert.equal(contactNameFromRecording('call.amr'), null);
  });
});

describe('speaker constraints', () => {
  const keys = [
    'ASSEMBLYAI_SPEAKER_LABELS',
    'ASSEMBLYAI_SPEAKERS_EXPECTED',
    'ASSEMBLYAI_MIN_SPEAKERS',
    'ASSEMBLYAI_MAX_SPEAKERS',
    'TRANSCRIPT_SELF_NAME',
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

  it('defaults to a 2–3 speaker phone-call range', () => {
    assert.deepEqual(getSpeakerConstraints(), {
      speaker_labels: true,
      speaker_options: {
        min_speakers_expected: 2,
        max_speakers_expected: 3,
      },
    });
  });

  it('honors an exact speakers_expected override', () => {
    process.env.ASSEMBLYAI_SPEAKERS_EXPECTED = '2';
    assert.deepEqual(getSpeakerConstraints(), {
      speaker_labels: true,
      speakers_expected: 2,
    });
  });

  it('can disable labels', () => {
    process.env.ASSEMBLYAI_SPEAKER_LABELS = '0';
    assert.deepEqual(getSpeakerConstraints(), { speaker_labels: false });
  });

  it('adds name identification when both names are known', () => {
    const body = buildTranscriptRequest('https://example/audio', {
      fileName: 'Cayden (+1 561-225-5142) ↗ (phone) 2026-09-23 13-30-56.amr',
      selfSpeakerName: 'Josh',
    });
    assert.equal(body.speaker_labels, true);
    assert.equal(body.speaker_options.min_speakers_expected, 2);
    assert.deepEqual(body.speech_understanding.request.speaker_identification, {
      speaker_type: 'name',
      known_values: ['Josh', 'Cayden'],
    });
  });

  it('skips identification when only one name is known', () => {
    assert.deepEqual(
      speakerIdentificationNames({
        fileName: 'Cayden (+1 561-225-5142).amr',
      }),
      [],
    );
  });
});

describe('utterance formatting', () => {
  it('formats generic and identified speakers', () => {
    assert.equal(
      formatUtterances([
        { speaker: 'A', text: 'Hello?' },
        { speaker: 'B', text: 'Hey, Mike.' },
      ]),
      'Speaker A: Hello?\n\nSpeaker B: Hey, Mike.',
    );
    assert.equal(
      formatUtterances([{ speaker: 'Cayden', text: 'Okay.' }]),
      'Cayden: Okay.',
    );
  });
});

describe('splitSpeakerTurns / docx paragraphs', () => {
  it('keeps blank-line speaker turns instead of smashing them', () => {
    const text = 'Speaker A: Hello.\n\nSpeaker B: Hi there.';
    assert.deepEqual(splitSpeakerTurns(text), [
      'Speaker A: Hello.',
      'Speaker B: Hi there.',
    ]);
    assert.deepEqual(transcriptToParagraphs(text), [
      'Speaker A: Hello.',
      'Speaker B: Hi there.',
    ]);
  });

  it('recovers inline Speaker A / Speaker B labels (current mashed .docx)', () => {
    const text =
      'Speaker A: Hello? Speaker B: Hey, Mike, it\'s Josh Osborne. How are you, man? Speaker A: Hey, good, how are you?';
    const turns = splitSpeakerTurns(text);
    assert.equal(turns.length, 3);
    assert.match(turns[0], /^Speaker A:/);
    assert.match(turns[1], /^Speaker B:/);
    assert.match(turns[2], /^Speaker A:/);
    assert.equal(countSpeakerLabels(text), 2);
    assert.equal(transcriptHasMultipleSpeakers(text), true);
  });

  it('detects a single-speaker Cayden-style transcript', () => {
    const text =
      'Speaker A: Hey, dude, sorry, I just got out of lunch with my pastor. Okay. Okay.';
    assert.deepEqual(uniqueSpeakerLabels(text), ['Speaker A']);
    assert.equal(transcriptHasMultipleSpeakers(text), false);
  });

  it('writes both speaker labels into the .docx as separate turns', async () => {
    const text = 'Speaker A: Hello?\n\nSpeaker B: Hey, Mike.';
    const buf = await buildTranscriptDocx(
      {
        fileName: 'Mike Trpkosh (+1 940-703-2097).amr',
        callee: '+19407032097',
        direction: 'Outgoing',
        durationSeconds: 12,
        recordedAt: '2026-09-23T20:00:00.000Z',
      },
      text,
    );
    assert.equal(countSpeakerLabelsInDocx(buf), 2);
  });

  it('falls back to sentence chunks when there are no speaker labels', () => {
    const chunks = transcriptToParagraphs('Hello. How are you? I am fine. Thanks. Bye.');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].includes('Speaker'), false);
  });
});

describe('stale speaker requeue', () => {
  const keys = ['REPROCESS_MISSING_SPEAKERS'];
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

  it('reopens done rows that predate speaker-label v2', () => {
    const stateData = {
      files: {
        cayden: { status: 'done', transcript_docx_file_id: 'docx-1' },
        fresh: {
          status: 'done',
          transcript_docx_file_id: 'docx-2',
          speaker_labels_version: SPEAKER_LABELS_VERSION,
        },
        short: { status: 'skipped_short' },
      },
    };
    assert.equal(needsSpeakerRelabel(stateData.files.cayden), true);
    assert.equal(needsSpeakerRelabel(stateData.files.fresh), false);

    const cleared = clearStaleSpeakerTranscripts(stateData, [
      'cayden',
      'fresh',
      'short',
    ]);
    assert.equal(cleared, 1);
    assert.equal(stateData.files.cayden, undefined);
    assert.equal(stateData.files.fresh.status, 'done');
    assert.equal(stateData.files.short.status, 'skipped_short');

    const processed = getAlreadyProcessedIds(stateData);
    assert.equal(processed.has('fresh'), true);
    assert.equal(processed.has('cayden'), false);
  });

  it('can disable requeue', () => {
    process.env.REPROCESS_MISSING_SPEAKERS = '0';
    const stateData = {
      files: { cayden: { status: 'done' } },
    };
    assert.equal(clearStaleSpeakerTranscripts(stateData, ['cayden']), 0);
    assert.equal(stateData.files.cayden.status, 'done');
  });
});
