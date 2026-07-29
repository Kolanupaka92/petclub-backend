'use strict';
/**
 * Pet health document extraction — turns a photo of a paper vaccination
 * card or vet report into structured candidate vet_records.
 *
 * This is the capture half of the digital pet passport. It is
 * deliberately a PROPOSAL, never a write: extraction only ever fills
 * `pet_health_documents.extracted`. The owner reviews and edits before
 * anything reaches `vet_records` (see POST .../confirm in server.js).
 * A hallucinated date or vaccine name is a real-world harm — a wrong
 * "next due" could mean a missed booster — so there is no code path
 * where this module's output lands in vet_records unconfirmed.
 *
 * Env-gated like the WhatsApp concierge: without ANTHROPIC_API_KEY,
 * extraction fails closed with a clear error rather than guessing.
 *
 * PUBLIC API
 *   isConfigured()                  → boolean
 *   extract(imageBuffer, mimeType)  → Promise<{ records: [...] }>
 *                                     throws on failure — caller marks
 *                                     the document status 'failed'.
 */

const { withRetry } = require('./retry');

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
    console.info('[PetHealthExtract] Claude vision extractor initialized');
  } catch (e) {
    console.error('[PetHealthExtract] Failed to init Anthropic SDK:', e.message);
  }
}

const isConfigured = () => Boolean(anthropic);

const MODEL = process.env.PET_HEALTH_EXTRACT_MODEL || 'claude-opus-4-8';

const SYSTEM_PROMPT = `You read photos of pet vaccination cards and vet visit
records and extract structured data. You are the FIRST pass only — a human
owner reviews and corrects everything you output before it is saved, so:

- Extract only what is legibly printed or handwritten on the document.
- Never infer, guess, or fill in a date, dose, or vaccine name that isn't
  actually visible. Leave a field null rather than guess.
- Dates: normalize to YYYY-MM-DD when the year is unambiguous; otherwise
  leave the field null and put the raw text in "notes".
- vtype should be a short vaccine/procedure name as written (e.g. "Rabies",
  "DHPP", "Bordetella", "Annual checkup") — not a category you invent.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "records": [
    {
      "vtype": string | null,
      "date": string | null,
      "next_due": string | null,
      "vet": string | null,
      "clinic": string | null,
      "batch_no": string | null,
      "vet_licence": string | null,
      "notes": string | null
    }
  ],
  "confidence": "high" | "medium" | "low",
  "warning": string | null
}

If the image isn't a vaccination card or vet record at all, return
"records": [] and explain briefly in "warning".`;

const extract = async (imageBuffer, mimeType) => {
  if (!anthropic) throw new Error('Pet health extraction is not configured (missing ANTHROPIC_API_KEY).');

  const response = await withRetry(() => anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBuffer.toString('base64') } },
        { type: 'text', text: 'Extract every vaccination or vet-visit record visible in this image.' },
      ],
    }],
  }));

  const raw = response.content?.[0]?.text?.trim() || '';
  // Claude occasionally wraps JSON in fences despite instructions — strip them defensively.
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse extraction result — the document may be unclear or unsupported.');
  }

  if (!Array.isArray(parsed.records)) throw new Error('Extraction returned an unexpected shape.');
  return parsed;
};

module.exports = { isConfigured, extract, SYSTEM_PROMPT };
