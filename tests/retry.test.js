'use strict';
const { withRetry, isTransient } = require('../services/retry');

describe('withRetry', () => {
  test('returns immediately on success (no retry)', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries transient errors up to the limit then throws', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('recovers when a later attempt succeeds', async () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValue('recovered');
    await expect(withRetry(fn, { retries: 3, baseMs: 1 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('does NOT retry permanent (4xx) errors — fails fast', async () => {
    const err = Object.assign(new Error('bad number'), { status: 400 });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { retries: 3, baseMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries 429 and 5xx', async () => {
    expect(isTransient({ status: 429 })).toBe(true);
    expect(isTransient({ status: 503 })).toBe(true);
    expect(isTransient({ status: 404 })).toBe(false);
    expect(isTransient({ code: 'EAI_AGAIN' })).toBe(true);
    expect(isTransient(null)).toBe(false);
  });

  test('onRetry hook errors never escape', async () => {
    const err = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    const fn = jest.fn().mockRejectedValue(err);
    const onRetry = jest.fn(() => { throw new Error('hook boom'); });
    await expect(withRetry(fn, { retries: 1, baseMs: 1, onRetry })).rejects.toBe(err);
    expect(onRetry).toHaveBeenCalled();
  });
});
