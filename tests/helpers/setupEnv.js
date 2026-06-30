'use strict';
/**
 * Jest setupFiles — runs before any test module is loaded.
 * Sets the minimum env vars server.js requires at startup.
 * Keep values clearly fake so no production system is ever contacted.
 */
process.env.JWT_SECRET          = 'test-jwt-secret-petclub-not-real';
process.env.SUPABASE_URL        = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key-not-real';
process.env.CRON_SECRET         = 'test-cron-secret-not-real';
process.env.JWT_EXPIRES_IN       = '30d';
process.env.NODE_ENV            = 'test';
process.env.ALLOW_DEV_TOOLS     = 'true';  // disables IS_PROD guards
// Prevent optional services from initialising in tests
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.RAZORPAY_KEY_ID;
