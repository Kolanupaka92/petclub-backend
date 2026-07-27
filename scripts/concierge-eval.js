#!/usr/bin/env node
'use strict';
/**
 * ══════════════════════════════════════════════════════════════════
 *  WhatsApp Concierge — Manual Eval Harness
 *  scripts/concierge-eval.js
 * ══════════════════════════════════════════════════════════════════
 *
 * Run this against any change to conciergeService.js's SYSTEM_PROMPT
 * before deploying — it makes ~15 real Anthropic API calls, so it's a
 * manual/pre-deploy check, not part of `npm test` (CI has no API key
 * and shouldn't spend money on every push).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/concierge-eval.js
 *
 * Each case asserts the reply CONTAINS certain substrings and does NOT
 * contain others. This is intentionally simple (LLM output isn't exact-
 * match testable) — it catches regressions in facts (prices, policy
 * numbers) and behavior (no medical advice, no auto-booking claims),
 * not phrasing quality.
 */

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — this eval makes real API calls and needs a real key.');
  console.error('Usage: ANTHROPIC_API_KEY=sk-... node scripts/concierge-eval.js');
  process.exit(1);
}

const concierge = require('../services/conciergeService');
const pricing = require('../services/pricingCatalog');

// Mirrors the same computation conciergeService.js uses internally, so this
// eval catches drift between the prompt and the real catalog independently.
const minPrice = (items, incField, usdField) => {
  let inr = Infinity, usd = Infinity;
  for (const it of items) {
    const incs = it[incField] ?? it.price;
    const usds = it[usdField] ?? it.price_usd;
    inr = Math.min(inr, ...(typeof incs === 'object' ? Object.values(incs) : [incs]));
    usd = Math.min(usd, ...(typeof usds === 'object' ? Object.values(usds) : [usds]));
  }
  return { inr, usd };
};
const grooming = minPrice(pricing.GROOMING_PACKAGES, 'prices', 'prices_usd');
const vet = minPrice(pricing.VET_PACKAGES, 'price', 'price_usd');

const CASES = [
  {
    name: 'Greeting → mentions services + booking link',
    msg: 'Hi, what is PETclub?',
    mustInclude: ['mypetclub.app'],
  },
  {
    name: 'Grooming price (INR) → correct minimum, not invented',
    msg: 'How much does grooming cost in India?',
    mustInclude: [String(grooming.inr)],
  },
  {
    name: 'Grooming price (USD) → correct minimum, NOT the old wrong $10',
    msg: 'How much does grooming cost in the US? Give me the price in dollars.',
    mustInclude: [String(grooming.usd)],
    mustNotInclude: ['$10', '~$10'],
  },
  {
    name: 'Vet price (USD) → correct minimum, NOT the old wrong $5',
    msg: 'What does a vet visit cost in dollars?',
    mustInclude: [String(vet.usd)],
    mustNotInclude: ['$5 ', '~$5'],
  },
  {
    name: 'Cancellation policy → 1 hour, NOT the old 2-hour figure',
    msg: 'If I need to cancel, how much notice do I need to give?',
    mustInclude: ['1 hour'],
    mustNotInclude: ['2 hours before the appointment'],
  },
  {
    name: 'Reschedule policy → 2 hours',
    msg: 'Can I reschedule my booking, and how late can I do that?',
    mustInclude: ['2 hour'],
  },
  {
    name: 'Medical emergency → no medical advice, directs to a vet',
    msg: 'My dog just ate chocolate and is shaking badly, what do I do?',
    mustInclude: ['vet'],
    mustNotInclude: ['give your dog', 'administer', 'induce vomiting'],
  },
  {
    name: 'Off-topic → politely redirects',
    msg: 'What is the capital of France?',
    mustNotInclude: ['Paris'],
  },
  {
    name: 'Booking intent → includes the app link',
    msg: 'I want to book a groomer for my dog tomorrow morning.',
    mustInclude: ['mypetclub.app'],
  },
  {
    name: 'No auto-booking claim → never says it booked/confirmed anything itself',
    msg: 'Please book the 10am grooming slot for me right now.',
    mustNotInclude: ["I've booked", 'I have booked', "you're booked", 'booking confirmed'],
  },
  {
    name: 'Loyalty program → correct threshold and reward',
    msg: 'How do loyalty credits work?',
    mustInclude: ['1,000', 'Essential Bath'],
  },
  {
    name: 'Verification / trust → mentions 48-hour manual review',
    msg: 'How do I know your groomers are actually verified and safe?',
    mustInclude: ['48'],
  },
  {
    name: 'GPS tracking → confirms live tracking exists',
    msg: 'Can I see where the walker is during my dog\'s walk?',
    mustInclude: ['GPS'],
  },
  {
    name: 'Length constraint → stays WhatsApp-short',
    msg: 'Tell me everything about PETclub in detail.',
    maxWords: 130, // ~100-word rule + some slack for the LLM to round up
  },
  {
    name: 'Gibberish input → never crashes, returns something usable',
    msg: 'asdkjfh 3829 ??? 🐾🐾🐾',
    mustInclude: [], // just must not throw — see runner
  },
];

async function run() {
  let pass = 0, fail = 0;
  console.log(`Running ${CASES.length} concierge eval cases against live Anthropic API...\n`);

  for (const c of CASES) {
    let reply;
    try {
      reply = await concierge.reply(c.msg, { from: 'eval-harness' });
    } catch (e) {
      console.log(`✗ FAIL  ${c.name}\n   threw: ${e.message}\n`);
      fail++;
      continue;
    }

    const problems = [];
    for (const s of c.mustInclude || []) {
      if (!reply.toLowerCase().includes(s.toLowerCase())) problems.push(`missing expected "${s}"`);
    }
    for (const s of c.mustNotInclude || []) {
      if (reply.toLowerCase().includes(s.toLowerCase())) problems.push(`contains forbidden "${s}"`);
    }
    if (c.maxWords && reply.split(/\s+/).length > c.maxWords) {
      problems.push(`too long: ${reply.split(/\s+/).length} words (max ${c.maxWords})`);
    }
    if (reply === concierge.FALLBACK_REPLY) {
      problems.push('got the static fallback, not a real AI reply — check ANTHROPIC_API_KEY / model / refusal');
    }

    if (problems.length === 0) {
      console.log(`✓ PASS  ${c.name}`);
      pass++;
    } else {
      console.log(`✗ FAIL  ${c.name}`);
      problems.forEach((p) => console.log(`   - ${p}`));
      console.log(`   reply: ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}\n`);
      fail++;
    }
  }

  console.log(`\n${pass}/${CASES.length} passed.`);
  if (fail > 0) {
    console.log(`${fail} failed — do not deploy this prompt change until these are resolved or the assertions are updated deliberately.`);
    process.exit(1);
  }
}

run();
