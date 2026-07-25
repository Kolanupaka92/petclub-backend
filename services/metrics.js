// ══════════════════════════════════════════════════════════════════
//  Lightweight product metrics — SLO instrumentation
//
//  Goal: answer the three questions Sentry can't, because they are
//  about business outcomes, not crashes:
//
//    1. booking_success_rate   — are bookings actually getting created?
//    2. dispatch_accept_rate   — are offers reaching a pro who accepts?
//    3. notification_delivery  — are OTP/push/WhatsApp actually sending?
//
//  Two outputs, zero new infrastructure:
//   • A structured log line per event ({ metric, outcome, ... }).
//     Cloud Logging turns these into log-based metrics → dashboards +
//     alerts. See docs/OBSERVABILITY.md.
//   • An in-process rolling counter snapshot, exposed at GET /api/metrics
//     (HEALTH_SECRET-gated) for a quick at-a-glance read without a
//     dashboard.
//
//  Counters are process-local (reset on deploy / per instance). That's
//  fine for SLO ratios over a scrape window; the durable source of
//  truth is the log-based metrics.
// ══════════════════════════════════════════════════════════════════
'use strict';

// name → { [outcome]: count }
const counters = Object.create(null);
const startedAt = Date.now();

function bump(name, outcome) {
  const c = counters[name] || (counters[name] = Object.create(null));
  c[outcome] = (c[outcome] || 0) + 1;
}

/**
 * Record a metric event.
 * @param {import('pino').Logger} logger
 * @param {string} name    - metric name, e.g. "booking_created"
 * @param {'success'|'failure'|'reject'|'no_pros'|string} outcome
 * @param {object} [labels] - extra structured context (never PII)
 */
function record(logger, name, outcome, labels = {}) {
  bump(name, outcome);
  // Single structured line → becomes a Cloud Logging log-based metric.
  // `metric: true` makes it trivially filterable: jsonPayload.metric=true
  if (logger && typeof logger.info === 'function') {
    logger.info({ metric: true, metric_name: name, outcome, ...labels }, `[metric] ${name}.${outcome}`);
  }
}

/** Snapshot for GET /api/metrics — includes derived SLO ratios. */
function snapshot() {
  const ratio = (name, good, bad) => {
    const c = counters[name] || {};
    const g = c[good] || 0;
    const b = c[bad] || 0;
    const total = g + b;
    return total === 0 ? null : Number((g / total).toFixed(4));
  };
  return {
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    counters,
    slo: {
      booking_success_rate: ratio('booking_created', 'success', 'failure'),
      dispatch_accept_rate: ratio('dispatch_offer', 'success', 'reject'),
      notification_delivery_rate: ratio('notification_send', 'success', 'failure'),
    },
  };
}

/** Test/ops helper — reset all counters. */
function reset() {
  for (const k of Object.keys(counters)) delete counters[k];
}

module.exports = { record, snapshot, reset };
