'use strict';
/**
 * petHealthExtractService: without ANTHROPIC_API_KEY the module must fail
 * closed — the route handler relies on isConfigured() to return a clean
 * 503 rather than crash on `anthropic.messages.create` against a null
 * client. This also guards the "never auto-write medical data" contract:
 * extract() must throw (not silently return empty records) when
 * unconfigured, so a caller can never mistake "not configured" for
 * "nothing was found on the card".
 */

describe('petHealthExtractService', () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    jest.resetModules();
  });

  test('isConfigured() is false and extract() throws when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    jest.resetModules();
    const svc = require('../services/petHealthExtractService');

    expect(svc.isConfigured()).toBe(false);
    await expect(svc.extract(Buffer.from('fake'), 'image/jpeg'))
      .rejects.toThrow(/not configured/i);
  });

  test('SYSTEM_PROMPT instructs the model to never guess missing fields', () => {
    const svc = require('../services/petHealthExtractService');
    expect(svc.SYSTEM_PROMPT).toMatch(/never infer, guess/i);
    expect(svc.SYSTEM_PROMPT).toMatch(/leave a? ?field null/i);
  });

  test('SYSTEM_PROMPT documents the expected JSON shape (records array)', () => {
    const svc = require('../services/petHealthExtractService');
    expect(svc.SYSTEM_PROMPT).toContain('"records"');
    expect(svc.SYSTEM_PROMPT).toContain('vtype');
    expect(svc.SYSTEM_PROMPT).toContain('next_due');
  });
});
