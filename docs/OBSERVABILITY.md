# Observability & SLOs

Sentry covers **crashes**. It does not tell us whether the *business* is
working — whether bookings are being created, whether offers reach a pro who
accepts, whether notifications actually send. Those are the three SLOs below.

## The three SLOs

| SLO | Metric event | Target (initial) |
|-----|--------------|------------------|
| **Booking success rate** | `booking_created.success` / (`success`+`failure`) | ≥ 99% |
| **Dispatch accept rate** | `dispatch_offer.success` / (`success`+`reject`) | ≥ 60% (tune with data) |
| **Notification delivery rate** | `notification_send.success` / (`success`+`failure`) | ≥ 98% |

These are starting targets. Watch the real numbers for two weeks post-launch,
then set error budgets.

## How it's instrumented

`services/metrics.js` emits **one structured log line per event**:

```json
{ "metric": true, "metric_name": "booking_created", "outcome": "success", "service_type": "Groomer" }
```

No new infrastructure — the log line is the metric. Two consumption paths:

### 1. Quick snapshot — `GET /api/metrics`
Gated by `HEALTH_SECRET` (same as `/api/health`):

```bash
curl -H "X-Health-Secret: $HEALTH_SECRET" https://api.mypetclub.app/api/metrics
```

Returns in-process counters + derived SLO ratios. Note: counters are
**per-instance and reset on deploy** — good for a live glance, not the
system of record.

### 2. Durable dashboards — Cloud Logging log-based metrics
Create counter metrics from the structured logs (one-time, GCP console or gcloud):

```bash
# Booking success counter
gcloud logging metrics create booking_created_success \
  --description="Successful booking creations" \
  --log-filter='jsonPayload.metric=true AND jsonPayload.metric_name="booking_created" AND jsonPayload.outcome="success"'

# Booking failure counter
gcloud logging metrics create booking_created_failure \
  --log-filter='jsonPayload.metric=true AND jsonPayload.metric_name="booking_created" AND jsonPayload.outcome="failure"'

# Repeat for dispatch_offer (success/reject) and notification_send (success/failure)
```

Then in **Cloud Monitoring**: build a dashboard with the ratio of each
success counter to its total, and add an alert policy when a ratio drops
below target for 15 min.

## Metric catalogue

| `metric_name` | outcomes | labels |
|---------------|----------|--------|
| `booking_created` | `success`, `failure` | `service_type`, `reason` |
| `dispatch_offer` | `success` (accepted), `reject` | `service_type` |
| `notification_send` | `success`, `failure` | `channel` (push/sms/whatsapp) |

Labels are **never PII** — service type and channel only.
