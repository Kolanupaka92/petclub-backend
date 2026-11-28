// Author: Sai Kolanupaka
'use strict';
const { Writable } = require('stream');
const { createLogger, scrub } = require('../services/logger');

function capture() {
  const lines = [];
  const dest = new Writable({
    write(chunk, _enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); },
  });
  const logger = createLogger({ level: 'debug' }, dest);
  return { logger, lines };
}

describe('logger keeps error details', () => {
  test('string passed after the label is kept', () => {
    const { logger, lines } = capture();
    logger.error('ID upload error:', 'Bucket not found');
    expect(lines[0].msg).toBe('ID upload error: Bucket not found');
  });

  test('Error passed after the label becomes err with stack', () => {
    const { logger, lines } = capture();
    logger.error('[FirebaseVerify] User lookup error:', new Error('boom'));
    expect(lines[0].msg).toBe('[FirebaseVerify] User lookup error: boom');
    expect(lines[0].err.message).toBe('boom');
    expect(lines[0].err.stack).toMatch(/Error: boom/);
  });

  test('Supabase error object keeps code and details', () => {
    const { logger, lines } = capture();
    logger.error('[Save failed]', { message: 'column "x" does not exist', code: '42703', details: null, hint: null });
    expect(lines[0].msg).toBe('[Save failed] column "x" does not exist');
    expect(lines[0].err.code).toBe('42703');
  });

  test('several extra values are all kept', () => {
    const { logger, lines } = capture();
    logger.error('[Loyalty] RPC error:', 'timeout', 'P0001');
    expect(lines[0].msg).toBe('[Loyalty] RPC error: timeout P0001');
  });

  test('pino native forms are unchanged', () => {
    const { logger, lines } = capture();
    logger.info({ bookingId: 'b1' }, 'dispatched');
    logger.warn('count %d', 3);
    logger.info('plain');
    expect(lines[0]).toMatchObject({ bookingId: 'b1', msg: 'dispatched' });
    expect(lines[1].msg).toBe('count 3');
    expect(lines[2].msg).toBe('plain');
  });

  test('missing error still logs the label', () => {
    const { logger, lines } = capture();
    logger.error('[x]', undefined);
    expect(lines[0].msg).toBe('[x] undefined');
  });
});

describe('logger hides credentials and contact details', () => {
  test('auth header, cookie and cron secret are redacted', () => {
    const { logger, lines } = capture();
    logger.info({ req: { headers: {
      authorization: 'Bearer eyJsecret', cookie: 'sid=abc', 'x-cron-secret': 's3', host: 'api',
    } } }, 'request');
    expect(lines[0].req.headers).toEqual({
      authorization: '[redacted]', cookie: '[redacted]', 'x-cron-secret': '[redacted]', host: 'api',
    });
  });

  test('email and phone in error text are masked', () => {
    const { logger, lines } = capture();
    logger.error('[Signup] insert failed:', {
      message: 'duplicate key value violates unique constraint "users_email_key"',
      code: '23505',
      details: 'Key (email)=(jane.doe@example.com) already exists.',
    });
    logger.warn('[SMS] failed for +91 98765 43210');
    expect(JSON.stringify(lines[0])).not.toContain('jane.doe@example.com');
    expect(lines[0].err.details).toContain('j***@example.com');
    expect(lines[1].msg).toBe('[SMS] failed for ***10');
  });

  test('ids, dates, times and amounts are not mistaken for phones', () => {
    const text = 'booking 3f2a1b4c-4123-8456-123456789012 at 2026-11-28 10:00 for 1499.00';
    expect(scrub(text)).toBe(text);
  });

  test('bare Error as first argument is masked', () => {
    const { logger, lines } = capture();
    logger.error(new Error('no user a@b.co'), 'lookup');
    expect(lines[0].err.message).toBe('no user a***@b.co');
    expect(lines[0].msg).toBe('lookup');
  });
});
