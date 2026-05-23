# PETclub Rewards — Support FAQ & Correction SOP

Internal document. Last updated: May 2026.
Use this before escalating any loyalty-related support query.

---

## Part 1 — Customer FAQ (copy-paste answers)

### "How do I earn points?"

> You earn PETclub Rewards credits automatically. Here's how:
> - **₹10 spent = 1 credit** on any booking paid through the app
> - **+50 credits** when you pay via in-app Razorpay
> - **+50 credits** when you write a verified review after your appointment
> - **+200 credits** when a friend you refer completes their first booking
>
> Credits appear in the **Rewards** section of your profile tab, usually within a few minutes of your payment or review being confirmed.

---

### "My points aren't showing after I booked."

Points are added **after payment is confirmed** by the payment gateway — not at booking creation. If the webhook hasn't fired yet, you'll see your credits listed as "Pending" (amber badge) in the Rewards tab. They will convert to real credits automatically within a few hours.

If they haven't appeared after 24 hours:
1. Check if the booking status shows "Confirmed" (not "Pending Payment").
2. Ask the customer to share their booking ID and phone number.
3. Use the admin correction flow below to manually add the missing points.

---

### "I submitted a review but didn't get the +50 bonus."

The review bonus is only awarded once per booking (to prevent abuse). If the customer reviewed the same booking twice, only the first review counts.

If the bonus is genuinely missing:
1. Confirm the booking ID and that the review was submitted and approved.
2. Use the admin correction flow below.

---

### "My referral code isn't working / my friend didn't get credit."

The **+200 referral bonus goes to the person who shared the code (the referrer)** — not to the friend. The friend earns credits normally through their own bookings.

The bonus is triggered when the referred friend completes their **first booking**. If the friend hasn't completed a booking yet, the credit won't appear yet — this is expected.

If the first booking is confirmed and the +200 still hasn't appeared after 24 hours, use the admin correction flow.

---

### "Can I transfer points to someone else?"

No. Points are tied to the account that earned them and cannot be transferred.

---

### "My coupon code isn't working at checkout."

The customer should check:
1. **Only one active coupon can exist at a time.** If they already have a valid unused coupon, they cannot redeem another until it's used.
2. **Coupons expire after 6 months** from the date of issue.
3. The coupon is tied to their account — it cannot be used by another user.

If the code looks valid but is being rejected, ask for the exact code and their user ID, then check in the database (`loyalty_coupons` table, `code` column).

---

### "I want to cancel my booking — will I lose the points I used?"

If the booking was a **loyalty redemption** (`is_loyalty_redemption = true`), the coupon was marked as `is_used = true` when the booking was created. Refunding the points requires a manual admin adjustment (see below). This is a business decision — refund if you cancelled the booking, do not refund if the customer no-showed.

---

## Part 2 — Correction SOP (how to fix points manually)

### The admin endpoint (your safe correction tool)

All point adjustments go through this endpoint. It's the **only** approved way to correct balances — never edit the database directly.

```
POST /api/admin/loyalty/award
Authorization: Bearer <admin-jwt-token>
Content-Type: application/json

{
  "userId": "<the user's UUID>",
  "points": 50,
  "type": "admin_award",
  "description": "Manual correction: review bonus not triggered for booking b00k1ng-id"
}
```

To **deduct** points (e.g. reversing a mistaken award), use a **negative** points value:
```json
{
  "userId": "<user UUID>",
  "points": -200,
  "type": "admin_award",
  "description": "Correction: duplicate referral bonus reversed, booking b00k1ng-id"
}
```

> ⚠️ Always include a clear `description`. Every award/deduction is logged in `loyalty_transactions` with your admin user ID — this is your audit trail.

---

### How to find a user's UUID

```
GET /api/admin/users?phone=9999900000
```

The response includes `id` — that's the UUID for the correction call.

---

### How to check the current state of a user's loyalty account

As admin, call the loyalty summary on behalf of a user by querying directly:

```sql
-- In Supabase SQL Editor
SELECT loyalty_points, referral_code FROM users WHERE id = '<user-uuid>';

SELECT * FROM loyalty_transactions
WHERE user_id = '<user-uuid>'
ORDER BY created_at DESC LIMIT 20;

SELECT * FROM loyalty_coupons
WHERE user_id = '<user-uuid>'
ORDER BY created_at DESC;
```

---

## Part 3 — Monitoring SOP

### Weekly check (5 minutes, every Monday)

Open the admin stats endpoint in your API client or curl:

```
GET /api/admin/loyalty/stats?days=7
Authorization: Bearer <admin-jwt-token>
```

Review:
- **`anomalies`** — should be an empty array `[]`. Any user listed earned >600 pts in a 24h window. Investigate before their balance reaches 1000 (redemption point).
- **`redemption_rate`** — if it's 0% after week 2, customers don't know the feature exists (push the explainer). If it's >80%, you're subsidising a lot of free services — review your earn rates.
- **`active_coupons`** — large number means customers are earning but not using. Send a push reminder.

### 30-day and 90-day check

Run with `?days=30` and `?days=90`. Compare redemption rate across windows. Target: 15–35% is healthy for a new program.

---

## Part 4 — Legal / Terms of Service language

Add the following paragraph to your Terms of Service (the existing `/terms.html` page):

> **PETclub Rewards Programme.** PETclub India ("PETclub") operates a loyalty credits programme ("Rewards"). Credits have no cash value, are non-transferable, and may only be redeemed as described in the app. PETclub reserves the right to modify, suspend, or terminate the Rewards programme, including point values, earn rules, and redemption thresholds, at any time and without prior notice. Credits that have not been redeemed at the time of any programme change or account termination will be forfeited. PETclub's decisions regarding credits disputes are final.

This clause protects you in four ways:
1. Prevents customers from claiming a "contract" to a specific earn rate
2. Lets you change the threshold (e.g. 1000 → 1500) without legal exposure
3. Covers account termination (suspended/banned users lose their credits)
4. Limits dispute escalation

---

*End of document. Update this file whenever earn rules or redemption thresholds change.*
