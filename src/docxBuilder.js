import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
} from 'docx';
import { splitSpeakerTurns, uniqueSpeakerLabels } from './speakers.js';

/**
 * Build a .docx Buffer with a metadata header and chunked transcript paragraphs.
 *
 * @param {object} meta
 * @param {string} meta.fileName
 * @param {string|null} meta.callee
 * @param {string|null} meta.direction
 * @param {number|null} meta.durationSeconds
 * @param {string|null} meta.recordedAt - ISO timestamp when available
 * @param {string} transcriptText
 */
export async function buildTranscriptDocx(meta, transcriptText) {
  const durationLabel =
    meta.durationSeconds == null
      ? 'unknown'
      : `${Number(meta.durationSeconds).toFixed(1)} seconds`;

  const speakerLabels = uniqueSpeakerLabels(transcriptText || '');
  const headerLines = [
    `Source recording: ${meta.fileName || 'unknown'}`,
    `Callee: ${meta.callee || 'unknown'}`,
    `Direction: ${meta.direction || 'unknown'}`,
    `Duration: ${durationLabel}`,
    `Recorded: ${formatRecorded(meta.recordedAt)}`,
  ];
  if (speakerLabels.length > 0) {
    headerLines.push(`Speakers: ${speakerLabels.join(', ')}`);
  }

  const paragraphs = [
    new Paragraph({
      text: 'Call Transcript',
      heading: HeadingLevel.HEADING_1,
    }),
    ...headerLines.map(
      (line) =>
        new Paragraph({
          children: [new TextRun({ text: line, size: 22 })],
          spacing: { after: 80 },
        }),
    ),
    new Paragraph({
      text: '',
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: 'Transcript',
      heading: HeadingLevel.HEADING_2,
    }),
    ...transcriptToParagraphs(transcriptText || '').map(paragraphForTurn),
  ];

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: paragraphs,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function formatRecorded(recordedAt) {
  if (!recordedAt) return 'unknown';
  const d = new Date(recordedAt);
  if (Number.isNaN(d.getTime())) return String(recordedAt);
  return d.toISOString();
}

export function transcriptToParagraphs(text) {
  const turns = splitSpeakerTurns(text);
  if (turns) return turns;
  return chunkIntoParagraphs(text);
}

function paragraphForTurn(chunk) {
  const trimmed = String(chunk || '').trim();
  const labeled = trimmed.match(
    /^((?:Speaker\s+[A-Z0-9]+)|(?:[^:\n]{1,60})):\s*([\s\S]*)$/i,
  );
  if (!labeled) {
    return new Paragraph({
      children: [new TextRun({ text: trimmed, size: 22 })],
      spacing: { after: 200 },
    });
  }
  return new Paragraph({
    children: [
      new TextRun({ text: `${labeled[1]}:`, bold: true, size: 22 }),
      new TextRun({ text: labeled[2] ? ` ${labeled[2]}` : '', size: 22 }),
    ],
    spacing: { after: 240 },
  });
}

/**
 * Split unlabeled transcript text into paragraphs of about 4 sentences each.
 */
export function chunkIntoParagraphs(text, sentencesPerParagraph = 4) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return ['(No transcript text returned.)'];
  }

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [trimmed];
  }

  const chunks = [];
  for (let i = 0; i < sentences.length; i += sentencesPerParagraph) {
    chunks.push(sentences.slice(i, i + sentencesPerParagraph).join(' '));
  }
  return chunks;
}
