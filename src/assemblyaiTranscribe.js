/**
 * Transcribe audio with AssemblyAI (Universal-2 by default).
 * Upload → create transcript → poll until completed.
 * Handles long phone calls in one request (no chunking needed).
 */

import {
  formatUtterances,
  getSpeakerConstraints,
  speakerIdentificationNames,
  uniqueSpeakersFromUtterances,
} from './speakers.js';

const BASE_URL = 'https://api.assemblyai.com';

export class AssemblyAIQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssemblyAIQuotaError';
  }
}

function getApiKey() {
  const key = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) {
    throw new Error('ASSEMBLYAI_API_KEY is required when TRANSCRIBE_PROVIDER=assemblyai');
  }
  return key;
}

function getSpeechModels() {
  // Prefer Universal-2 for cost; override with ASSEMBLYAI_SPEECH_MODELS=universal-3-5-pro,universal-2
  const raw = process.env.ASSEMBLYAI_SPEECH_MODELS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env.ASSEMBLYAI_SPEECH_MODEL?.trim();
  if (single) return [single];
  return ['universal-2'];
}

/**
 * Build the AssemblyAI create-transcript body (exported for tests).
 * @param {string} audioUrl
 * @param {{ fileName?: string, selfSpeakerName?: string, otherSpeakerName?: string }} [opts]
 */
export function buildTranscriptRequest(audioUrl, opts = {}) {
  const speechModels = getSpeechModels();
  const body = {
    audio_url: audioUrl,
    speech_models: speechModels,
    language_code: process.env.ASSEMBLYAI_LANGUAGE_CODE?.trim() || 'en',
    ...getSpeakerConstraints(),
  };

  const names = speakerIdentificationNames(opts);
  if (body.speaker_labels && names.length >= 2) {
    body.speech_understanding = {
      request: {
        speaker_identification: {
          speaker_type: 'name',
          known_values: names,
        },
      },
    };
  }
  return body;
}

/**
 * @param {string} fileName
 * @param {Buffer} audioBuffer
 * @param {{ selfSpeakerName?: string, otherSpeakerName?: string }} [opts]
 * @returns {Promise<string>} transcript text
 */
export async function transcribeWithAssemblyAI(fileName, audioBuffer, opts = {}) {
  const apiKey = getApiKey();
  const headers = { authorization: apiKey };

  const uploadRes = await fetch(`${BASE_URL}/v2/upload`, {
    method: 'POST',
    headers,
    body: audioBuffer,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throwQuotaOrError('upload', uploadRes.status, body);
  }
  const uploadJson = await uploadRes.json();
  const audioUrl = uploadJson.upload_url;
  if (!audioUrl) {
    throw new Error('AssemblyAI upload response missing upload_url');
  }

  const request = buildTranscriptRequest(audioUrl, {
    fileName,
    selfSpeakerName: opts.selfSpeakerName,
    otherSpeakerName: opts.otherSpeakerName,
  });
  const createRes = await fetch(`${BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throwQuotaOrError('create', createRes.status, body);
  }
  const created = await createRes.json();
  const transcriptId = created.id;
  if (!transcriptId) {
    throw new Error('AssemblyAI create transcript response missing id');
  }
  const speakerHint = request.speaker_options
    ? `speakers=${request.speaker_options.min_speakers_expected}-${request.speaker_options.max_speakers_expected}`
    : request.speakers_expected
      ? `speakers=${request.speakers_expected}`
      : 'speakers=off';
  console.log(
    `AssemblyAI job ${transcriptId} for ${fileName} (models=${request.speech_models.join(',')}, ${speakerHint})`,
  );

  const text = await pollTranscript(apiKey, transcriptId);
  return text;
}

async function pollTranscript(apiKey, transcriptId) {
  const pollMs = Math.max(
    1000,
    Number(process.env.ASSEMBLYAI_POLL_MS || 3000) || 3000,
  );
  const maxWaitMs = Math.max(
    60_000,
    Number(process.env.ASSEMBLYAI_MAX_WAIT_MS || 45 * 60_000) || 45 * 60_000,
  );
  const started = Date.now();

  for (;;) {
    const res = await fetch(`${BASE_URL}/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      throwQuotaOrError('poll', res.status, body);
    }
    const data = await res.json();
    if (data.status === 'completed') {
      if (typeof data.text !== 'string' || !data.text.trim()) {
        throw new Error(`AssemblyAI transcript ${transcriptId} completed with empty text`);
      }
      if (Array.isArray(data.utterances) && data.utterances.length > 0) {
        const speakers = uniqueSpeakersFromUtterances(data.utterances);
        console.log(
          `AssemblyAI transcript ${transcriptId} speakers=${speakers.length} (${speakers.join(', ') || 'none'}) utterances=${data.utterances.length}`,
        );
        return formatUtterances(data.utterances);
      }
      return data.text;
    }
    if (data.status === 'error') {
      throw new Error(
        `AssemblyAI transcription failed: ${data.error || 'unknown error'} (id=${transcriptId})`,
      );
    }
    if (Date.now() - started > maxWaitMs) {
      throw new Error(
        `AssemblyAI transcription timed out after ${Math.round(maxWaitMs / 1000)}s (id=${transcriptId}, status=${data.status})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function throwQuotaOrError(step, status, body) {
  if (
    status === 402 ||
    status === 429 ||
    /insufficient|quota|credit|payment|billing|balance/i.test(body)
  ) {
    throw new AssemblyAIQuotaError(
      `AssemblyAI ${step} failed (${status}): ${body}`,
    );
  }
  throw new Error(`AssemblyAI ${step} failed (${status}): ${body}`);
}
