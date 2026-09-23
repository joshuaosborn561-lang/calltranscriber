import { inflateRawSync } from 'node:zlib';

/**
 * Speaker-label helpers for Cube ACR phone calls.
 *
 * AssemblyAI returns utterances as Speaker A / Speaker B (or identified names).
 * Phone recordings are two-party, so we require at least two labels.
 */

export const SPEAKER_LABELS_VERSION = 2;

const GENERIC_SPEAKER_RE = /Speaker\s+([A-Z0-9]+):/gi;
const GENERIC_SPEAKER_SPLIT_RE = /(?=Speaker\s+[A-Z0-9]+:)/i;
const GENERIC_SPEAKER_START_RE = /^Speaker\s+[A-Z0-9]+:/i;
const NAMED_TURN_RE = /^[^:\n]{1,60}:\s+/;

export function speakerLabelsEnabled() {
  return process.env.ASSEMBLYAI_SPEAKER_LABELS !== '0';
}

/**
 * Exact count (speakers_expected) or a min/max range.
 * Defaults force a 2-party phone call (min 2, max 3).
 */
export function getSpeakerConstraints() {
  if (!speakerLabelsEnabled()) return { speaker_labels: false };

  const exactRaw = process.env.ASSEMBLYAI_SPEAKERS_EXPECTED;
  const exact = Number(exactRaw);
  if (exactRaw != null && exactRaw !== '' && Number.isFinite(exact) && exact >= 1) {
    return {
      speaker_labels: true,
      speakers_expected: Math.floor(exact),
    };
  }

  const min = Math.max(
    1,
    Math.floor(Number(process.env.ASSEMBLYAI_MIN_SPEAKERS || 2) || 2),
  );
  const max = Math.max(
    min,
    Math.floor(Number(process.env.ASSEMBLYAI_MAX_SPEAKERS || 3) || 3),
  );
  return {
    speaker_labels: true,
    speaker_options: {
      min_speakers_expected: min,
      max_speakers_expected: max,
    },
  };
}

/** "Cayden (+1 561-225-5142) ↗ (phone) 2026-09-23 13-30-56.amr" → "Cayden" */
export function contactNameFromRecording(fileName) {
  if (!fileName) return null;
  const base = String(fileName).replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)\s+\(\+?\d/);
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}

export function speakerIdentificationNames({
  fileName,
  selfSpeakerName,
  otherSpeakerName,
} = {}) {
  const other = String(
    otherSpeakerName || contactNameFromRecording(fileName) || '',
  ).trim();
  const self = String(
    selfSpeakerName || process.env.TRANSCRIPT_SELF_NAME || '',
  ).trim();
  const names = [];
  const seen = new Set();
  for (const name of [self, other]) {
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.length >= 2 ? names : [];
}

export function formatUtterance(utterance) {
  const text = String(utterance?.text || '').trim();
  if (!text) return '';
  const raw = String(utterance?.speaker ?? 'A').trim();
  if (!raw) return text;
  if (/^speaker\s+/i.test(raw)) return `${raw}: ${text}`;
  if (/^[A-Z0-9]$/i.test(raw) || /^\d+$/.test(raw)) {
    return `Speaker ${raw.toUpperCase()}: ${text}`;
  }
  return `${raw}: ${text}`;
}

export function formatUtterances(utterances) {
  return (utterances || [])
    .map(formatUtterance)
    .filter(Boolean)
    .join('\n\n');
}

export function uniqueSpeakersFromUtterances(utterances) {
  const found = [];
  const seen = new Set();
  for (const u of utterances || []) {
    const label = String(u?.speaker ?? '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(label);
  }
  return found;
}

export function uniqueSpeakerLabels(text) {
  const found = [];
  const seen = new Set();
  const add = (label) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(label);
  };

  const raw = String(text || '');
  for (const m of raw.matchAll(GENERIC_SPEAKER_RE)) {
    add(`Speaker ${m[1].toUpperCase()}`);
  }

  if (found.length >= 2) return found;

  const blocks = raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocks.length >= 2 && blocks.every((b) => NAMED_TURN_RE.test(b))) {
    for (const block of blocks) {
      const label = block.split(':')[0].trim();
      if (label) add(label);
    }
  }

  return found;
}

export function countSpeakerLabels(text) {
  return uniqueSpeakerLabels(text).length;
}

/** Inflate word/document.xml from a .docx (zip) buffer. */
export function extractDocxXml(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  let offset = 0;
  while (offset < buf.length - 30) {
    if (
      buf[offset] !== 0x50 ||
      buf[offset + 1] !== 0x4b ||
      buf[offset + 2] !== 0x03 ||
      buf[offset + 3] !== 0x04
    ) {
      offset += 1;
      continue;
    }
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (dataStart > buf.length) break;
    const end = compressedSize > 0 ? dataStart + compressedSize : buf.length;
    const data = buf.subarray(dataStart, Math.min(end, buf.length));
    if (name === 'word/document.xml') {
      if (compression === 0) return data.toString('utf8');
      if (compression === 8) return inflateRawSync(data).toString('utf8');
      throw new Error(`Unsupported docx zip compression ${compression}`);
    }
    offset = compressedSize > 0 ? dataStart + compressedSize : offset + 4;
  }
  return '';
}

export function extractDocxText(buffer) {
  const xml = extractDocxXml(buffer);
  if (!xml) return '';
  return xml
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/** Scan a .docx buffer for Speaker A / Speaker B labels. */
export function countSpeakerLabelsInDocx(buffer) {
  const text = extractDocxText(buffer);
  if (text) return countSpeakerLabels(text);
  const raw = Buffer.isBuffer(buffer)
    ? buffer.toString('utf8')
    : String(buffer || '');
  return countSpeakerLabels(raw);
}

export function transcriptHasMultipleSpeakers(textOrBuffer) {
  if (Buffer.isBuffer(textOrBuffer)) {
    return countSpeakerLabelsInDocx(textOrBuffer) >= 2;
  }
  return countSpeakerLabels(textOrBuffer) >= 2;
}

/**
 * Recover speaker turns from either blank-line-separated or inline labels.
 * Returns null when the text is a single unlabeled block (use sentence chunking).
 */
export function splitSpeakerTurns(text) {
  const raw = String(text || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!raw) return null;

  const blocks = raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocks.length >= 2 && blocks.every((b) => NAMED_TURN_RE.test(b))) {
    return blocks;
  }

  if (GENERIC_SPEAKER_START_RE.test(raw) || /Speaker\s+[A-Z0-9]+:/i.test(raw)) {
    const parts = raw
      .split(GENERIC_SPEAKER_SPLIT_RE)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((p) => GENERIC_SPEAKER_START_RE.test(p));
    if (parts.length >= 1) return parts;
  }

  return null;
}
