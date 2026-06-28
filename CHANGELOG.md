## [1.28.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.28.1...v1.28.2) (2026-06-28)


### Bug Fixes

* **auth:** remove debug log from auth middleware ([15c7abe](https://github.com/Kolanupaka92/petclub-backend/commit/15c7abeb04b8c696dc186219fd87b7982364d35e))

## [1.28.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.28.0...v1.28.1) (2026-06-27)


### Bug Fixes

* repair curly-quote encoding corruption in server.js ([5701490](https://github.com/Kolanupaka92/petclub-backend/commit/5701490458ced640860cf5eee5ca91517745fdb4))

# [1.28.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.27.0...v1.28.0) (2026-06-27)


### Features

* pet delete route, admin soft-delete filter, 90-day hard-purge cron ([22b5081](https://github.com/Kolanupaka92/petclub-backend/commit/22b5081bc2536e9c4d6f3e3c65ce4daf67d580f5))

# [1.27.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.26.2...v1.27.0) (2026-06-27)


### Features

* soft delete on users, bookings, pets ([b40668e](https://github.com/Kolanupaka92/petclub-backend/commit/b40668e9869d1522cf40005f3468f11989f0702c))

## [1.26.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.26.1...v1.26.2) (2026-06-27)


### Bug Fixes

* health check DB ping -- replace non-existent pg_sleep RPC with direct table query ([5e77dcf](https://github.com/Kolanupaka92/petclub-backend/commit/5e77dcf3b899538d7c85f6fb06cc0e75f7612131))

## [1.26.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.26.0...v1.26.1) (2026-06-27)


### Bug Fixes

* pino-pretty only in development, not staging/production ([cbe8e5f](https://github.com/Kolanupaka92/petclub-backend/commit/cbe8e5f23b67e08d69841fc45a43d5bea450e46e))

# [1.26.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.25.0...v1.26.0) (2026-06-27)


### Features

* add API versioning -- /api/v1/* aliases /api/* ([19788d8](https://github.com/Kolanupaka92/petclub-backend/commit/19788d88637d6cbe99b3a6f496df49b009a14d0f))

# [1.25.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.24.0...v1.25.0) (2026-06-27)


### Features

* replace SSE polling with Supabase Realtime for live tracking ([9481065](https://github.com/Kolanupaka92/petclub-backend/commit/9481065b54019a1abd4d0b30bbe9f2484a820445))

# [1.24.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.5...v1.24.0) (2026-06-27)


### Features

* add structured JSON logging with pino ([e0fde58](https://github.com/Kolanupaka92/petclub-backend/commit/e0fde58cf16b678e8668bf352cf86f919869b1c0))

## [1.23.5](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.4...v1.23.5) (2026-06-27)


### Bug Fixes

* harden OTP entropy, audit loyalty awards, pin Docker image, tune Cloud Run ([ed66cb8](https://github.com/Kolanupaka92/petclub-backend/commit/ed66cb88a3144082e5aec9527c60650e12bbc2a4))

## [1.23.4](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.3...v1.23.4) (2026-06-27)


### Bug Fixes

* **loyalty:** fix stale leaderboard entries and broken stat card field names ([770b420](https://github.com/Kolanupaka92/petclub-backend/commit/770b420d4819e14f8bcf40291408a84da60e0fa6))

## [1.23.3](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.2...v1.23.3) (2026-06-27)


### Bug Fixes

* **ratelimit:** raise OTP/auth limits, switch to direct Supabase host ([f7c1490](https://github.com/Kolanupaka92/petclub-backend/commit/f7c1490852e9f1fd4982b8cab0b86d04bf09d74e))

## [1.23.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.1...v1.23.2) (2026-06-27)


### Bug Fixes

* **ratelimit:** use direct Supabase host instead of Supavisor pooler ([2ecaa63](https://github.com/Kolanupaka92/petclub-backend/commit/2ecaa63a04183fa9cd16c2656000187e196ac3b1))

## [1.23.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.23.0...v1.23.1) (2026-06-27)


### Bug Fixes

* **admin:** remove .catch() from Supabase query chains in db-cleanup ([24e0617](https://github.com/Kolanupaka92/petclub-backend/commit/24e061740aa928960456e47918ff86749269ffa4))

# [1.23.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.5...v1.23.0) (2026-06-01)


### Features

* **infra:** Sentry error tracking + RLS migration + Secret Manager scripts ([88ced90](https://github.com/Kolanupaka92/petclub-backend/commit/88ced906d84baa43ed6c55b921a33bf6acd0b75a))

## [1.22.5](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.4...v1.22.5) (2026-05-31)


### Bug Fixes

* **rate-limit:** correct pooler region + use DB password not JWT ([6861c73](https://github.com/Kolanupaka92/petclub-backend/commit/6861c73ed41d74fb1f64986ffc4e76ac39353f50))

## [1.22.4](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.3...v1.22.4) (2026-05-31)


### Bug Fixes

* **auth:** improve firebase-verify logging + expand email OTP rate-limit window ([1118ce3](https://github.com/Kolanupaka92/petclub-backend/commit/1118ce339466e8a2dafcbee7121dfc50595f4e3a))

## [1.22.3](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.2...v1.22.3) (2026-05-30)


### Bug Fixes

* **pro-profile:** stop JSON.stringify on services array, surface update errors ([186b3ab](https://github.com/Kolanupaka92/petclub-backend/commit/186b3ab509445b3f26eb7bac8064b5516eb707d6))

## [1.22.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.1...v1.22.2) (2026-05-30)


### Bug Fixes

* **pricing:** update grooming packages + add walking & boarding catalog ([e3c5845](https://github.com/Kolanupaka92/petclub-backend/commit/e3c5845d31f0e24665af614ee2ced3f2d58c88e5))

## [1.22.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.22.0...v1.22.1) (2026-05-30)


### Bug Fixes

* **e2e:** 3 bugs found in E2E verification ([59deecd](https://github.com/Kolanupaka92/petclub-backend/commit/59deecddba7121ff9ae6a5e772445f30dd685eb6))

# [1.22.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.21.0...v1.22.0) (2026-05-29)


### Features

* pro cancel+redispatch, loyalty reversal, refund mgmt, chat masking ([5426bf6](https://github.com/Kolanupaka92/petclub-backend/commit/5426bf6759f1804c604dee534b2482de7a7bb13f))

# [1.21.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.20.0...v1.21.0) (2026-05-29)


### Features

* cancellation policy + no-show + service notes + refund logic ([5bcd5de](https://github.com/Kolanupaka92/petclub-backend/commit/5bcd5de32bd522a4f50a6ba13526305bf8ff6338))

# [1.20.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.19.0...v1.20.0) (2026-05-29)


### Features

* **chat:** booking_messages table + GET/POST endpoints ([c33b448](https://github.com/Kolanupaka92/petclub-backend/commit/c33b448140fc7055418dae492a4c76aed2ac1fdf))

# [1.19.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.18.1...v1.19.0) (2026-05-29)


### Features

* **pets:** auto-create service record when booking is completed ([2c34b3f](https://github.com/Kolanupaka92/petclub-backend/commit/2c34b3f9b6db563a07d4cce61612f1b977a83812))

## [1.18.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.18.0...v1.18.1) (2026-05-29)


### Bug Fixes

* **auth:** include email in set-role response ([5e66da7](https://github.com/Kolanupaka92/petclub-backend/commit/5e66da7808b0b99f4ee00d89f965b431971ad1b5))

# [1.18.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.17.0...v1.18.0) (2026-05-29)


### Features

* **billing:** groomer 70/30 split on net after PETclub offer deduction ([a616a12](https://github.com/Kolanupaka92/petclub-backend/commit/a616a1280037b164ce39aa05c3ac22f2033cd5b4))

# [1.17.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.16.1...v1.17.0) (2026-05-29)


### Features

* **notifications:** add WhatsApp booking notification to groomers/trainers ([0e5bc76](https://github.com/Kolanupaka92/petclub-backend/commit/0e5bc760923cf69531d864a7a9820be9166d81c0))

## [1.16.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.16.0...v1.16.1) (2026-05-29)


### Bug Fixes

* **e2e:** skip rate limiter for E2E test email domain ([ad7f87f](https://github.com/Kolanupaka92/petclub-backend/commit/ad7f87f55afd83aacd9ac429bcb530e9451499ef))

# [1.16.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.15.1...v1.16.0) (2026-05-29)


### Features

* **e2e:** add E2E_TEST_EMAIL_DOMAIN bypass for email OTP testing ([bfab91c](https://github.com/Kolanupaka92/petclub-backend/commit/bfab91c7c66a7ee49293bc4dda9f341563d65473))

## [1.15.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.15.0...v1.15.1) (2026-05-27)


### Bug Fixes

* **rbac:** enforce professional-only access on /incoming, /me, /availability endpoints ([6d633c4](https://github.com/Kolanupaka92/petclub-backend/commit/6d633c4050628e4d1a1be88839359f07265f4384))

# [1.15.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.14.4...v1.15.0) (2026-05-27)


### Features

* add Walker and Boarding professional roles to all backend whitelists ([d7fd12b](https://github.com/Kolanupaka92/petclub-backend/commit/d7fd12b1974c9bc96b402ac2580d290a26b831b7))

## [1.14.4](https://github.com/Kolanupaka92/petclub-backend/compare/v1.14.3...v1.14.4) (2026-05-27)


### Bug Fixes

* **ci:** rewrite health-monitor.yml with clean ASCII YAML ([f7cea67](https://github.com/Kolanupaka92/petclub-backend/commit/f7cea67ec560735ad6a3a81ba1672c31da3e6c63))

## [1.14.3](https://github.com/Kolanupaka92/petclub-backend/compare/v1.14.2...v1.14.3) (2026-05-27)


### Bug Fixes

* **health:** ping DB on every health check to prevent Supabase auto-pause ([45a82b8](https://github.com/Kolanupaka92/petclub-backend/commit/45a82b80c79f9c6c1678476c4159ceab076aeef7))

## [1.14.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.14.1...v1.14.2) (2026-05-27)


### Bug Fixes

* **ci:** move GCP_SA_KEY check out of job-level if into env + step conditions ([bcafcdd](https://github.com/Kolanupaka92/petclub-backend/commit/bcafcddad2af1ad21403cff84f7318df1b335616))

## [1.14.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.14.0...v1.14.1) (2026-05-25)


### Bug Fixes

* **loyalty:** handle scalar return from sum_loyalty_earned_in_window RPC ([80da8ea](https://github.com/Kolanupaka92/petclub-backend/commit/80da8eae3e54a0ddc295964068c878ec8aa1be33))

# [1.14.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.13.0...v1.14.0) (2026-05-25)


### Features

* **ops:** add automated health monitor with 2-hour cron, SMS alerts, auto-recovery ([d40c208](https://github.com/Kolanupaka92/petclub-backend/commit/d40c2087b2c772f11a1cf11856f1af456c9b0682))

# [1.13.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.12.1...v1.13.0) (2026-05-25)


### Bug Fixes

* **admin:** normalise PostgREST one-to-one embeds to arrays in GET /api/admin/users ([d9cc53b](https://github.com/Kolanupaka92/petclub-backend/commit/d9cc53b7d477c6034872af916ce9178f954f9b8e))
* **loyalty:** rename RPC to redeem_loyalty_coupon, add dedicated migrations ([2118f03](https://github.com/Kolanupaka92/petclub-backend/commit/2118f035a7419c1468f2560d5106d50e62937ca2))
* **security:** enable Helmet CSP for backend API (replaces contentSecurityPolicy: false) ([fe2ad36](https://github.com/Kolanupaka92/petclub-backend/commit/fe2ad3657d471c24e411f22a3e88dbdb1a64e12f))
* **security:** replace in-memory rate limiter with distributed Postgres-backed store ([95b477d](https://github.com/Kolanupaka92/petclub-backend/commit/95b477d82071224d5293cbb9bcb259f9c61d86e0))
* **security:** tighten JWT expiry from 30 days to 7 days ([e97dd26](https://github.com/Kolanupaka92/petclub-backend/commit/e97dd2651a8b5b757a0814fba68158eb60dd8b44))
* **sql:** add missing sum_loyalty_earned_in_window RPC, populate mat view on deploy, fix stale verification query ([d54d414](https://github.com/Kolanupaka92/petclub-backend/commit/d54d4146600112f87ad2dae4e692a777c56346c2))


### Features

* **billing:** update revenue split from 70/30 to 45/55 (partner/platform) ([644e588](https://github.com/Kolanupaka92/petclub-backend/commit/644e5880e3c97c4fdfd097b5d987c8a8979ec08f))
* **payments:** add Razorpay webhook + award booking_spend/payment_bonus loyalty credits ([48b2257](https://github.com/Kolanupaka92/petclub-backend/commit/48b22579d72d4283ca60416c236016c36ca02f05))

## [1.12.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.12.0...v1.12.1) (2026-05-24)


### Bug Fixes

* **keepalive:** add daily timestamp commit to prevent GitHub 60-day workflow disable ([276dd3c](https://github.com/Kolanupaka92/petclub-backend/commit/276dd3c9022f76ed06a7dc3bea812a3f3fad4ea9))

# [1.12.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.11.1...v1.12.0) (2026-05-24)


### Bug Fixes

* sync package-lock.json with package.json ([55f4985](https://github.com/Kolanupaka92/petclub-backend/commit/55f498580013a65cd18e1d60610b168821f595fe))


### Features

* **booking:** clickwrap Terms & Conditions consent with audit trail ([2d7e9d2](https://github.com/Kolanupaka92/petclub-backend/commit/2d7e9d2d3aabc76269da843573cd4b143d9c36d6))
* **loyalty:** add operational readiness layer for launch ([5878a8d](https://github.com/Kolanupaka92/petclub-backend/commit/5878a8db9d986e0819448f0ca8bfe3b24a1eb1c8))
* Referral & Partner Commission system ([1313c7d](https://github.com/Kolanupaka92/petclub-backend/commit/1313c7d5af7a553e284b07b0df11cd789258c01c))

## [1.11.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.11.0...v1.11.1) (2026-05-23)


### Bug Fixes

* **loyalty:** harden loyalty system — 5 bulletproof fixes ([181da4e](https://github.com/Kolanupaka92/petclub-backend/commit/181da4eb6256611a581de20634392c6cb445b4ef))

# [1.11.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.10.0...v1.11.0) (2026-05-23)


### Features

* **loyalty:** add loyalty credits system — earn, redeem, and coupon logic ([e2f1be1](https://github.com/Kolanupaka92/petclub-backend/commit/e2f1be122e977e9c1f1eae9f90587cffee3e7807))

# [1.10.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.9.1...v1.10.0) (2026-05-23)


### Features

* **pricing:** add centralized pricing catalog and server-side amount calculation ([6cf50c6](https://github.com/Kolanupaka92/petclub-backend/commit/6cf50c6df6acdb0953f265d7e8baa320fbc11134))

## [1.9.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.9.0...v1.9.1) (2026-05-23)


### Bug Fixes

* **admin:** use correct column scheduled_at in db-audit stale_upcoming query ([ab93e52](https://github.com/Kolanupaka92/petclub-backend/commit/ab93e52d3a11e9fdf24c4e8d0df4a7742e36ac06))

# [1.9.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.8.3...v1.9.0) (2026-05-23)


### Features

* **admin:** add no_pros_available cleanup target + audit count ([5d96a03](https://github.com/Kolanupaka92/petclub-backend/commit/5d96a03998fe0055a4a37a9cd478cca4ae2c8a6b))

## [1.8.3](https://github.com/Kolanupaka92/petclub-backend/compare/v1.8.2...v1.8.3) (2026-05-23)


### Bug Fixes

* **reviews:** use correct DB column name 'comment' and add error handling ([043259e](https://github.com/Kolanupaka92/petclub-backend/commit/043259edcbe521ea5b077bf7cf1e5dccf7098920))

## [1.8.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.8.1...v1.8.2) (2026-05-23)


### Bug Fixes

* remove !user_id hint from nested professional_profiles->users join ([cb6c605](https://github.com/Kolanupaka92/petclub-backend/commit/cb6c605347debacef9e9b9c8645a01c9fc4999c7))

## [1.8.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.8.0...v1.8.1) (2026-05-23)


### Bug Fixes

* add FK hints to GET /bookings PostgREST query + log errors ([ce67e1e](https://github.com/Kolanupaka92/petclub-backend/commit/ce67e1e93035c10290f99ecc208349b4f3fd1c9c))

# [1.8.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.7.0...v1.8.0) (2026-05-23)


### Features

* **admin:** real service health pings in /api/admin/health ([15867f2](https://github.com/Kolanupaka92/petclub-backend/commit/15867f2e49ba594a647498c6263b36bfee01a332))

# [1.7.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.6.3...v1.7.0) (2026-05-23)


### Features

* **admin:** add /api/admin/health endpoint for Platform Status widget ([53f571b](https://github.com/Kolanupaka92/petclub-backend/commit/53f571b8fe4ff3e72182907f10b9a37be0116b4c))

## [1.6.3](https://github.com/Kolanupaka92/petclub-backend/compare/v1.6.2...v1.6.3) (2026-05-23)


### Bug Fixes

* **auth:** email fallback when Twilio SMS fails in send-phone-otp ([bf364c7](https://github.com/Kolanupaka92/petclub-backend/commit/bf364c7ee8d818cabe6377f7eeb9edf602cec439))

## [1.6.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.6.1...v1.6.2) (2026-05-23)


### Bug Fixes

* **admin:** cascade FK deletes in purge-all-suspended + single-user delete ([0947e55](https://github.com/Kolanupaka92/petclub-backend/commit/0947e558f14e3cff20507d948575efd03ef2c33c))
* **admin:** remove .catch() from Supabase query chains (not supported in v2) ([8043462](https://github.com/Kolanupaka92/petclub-backend/commit/8043462cfeae4b2040fe3018fc269620ba42166c))

## [1.6.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.6.0...v1.6.1) (2026-05-23)


### Bug Fixes

* correct stale PATCH reference in seed instructions output ([efda175](https://github.com/Kolanupaka92/petclub-backend/commit/efda17564c497b20885183aa364ade69724770bb))

# [1.6.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.5.0...v1.6.0) (2026-05-23)


### Features

* add POST /api/test/move-seed-provider (live GPS simulation) ([21ea199](https://github.com/Kolanupaka92/petclub-backend/commit/21ea199bdfdf309c9678445631bff896b599b49c))

# [1.5.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.4.0...v1.5.0) (2026-05-23)


### Features

* add POST /api/test/seed-active-provider (dev-only map test seed) ([4e85831](https://github.com/Kolanupaka92/petclub-backend/commit/4e85831111845eca26a1baf6d4ba74b996829744))

# [1.4.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.3.0...v1.4.0) (2026-05-23)


### Features

* **email:** route transactional emails via Zoho Groups ([33e834e](https://github.com/Kolanupaka92/petclub-backend/commit/33e834e66ace4c0873a86d2697381ed399321937))

# [1.3.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.2.0...v1.3.0) (2026-05-23)


### Features

* **email:** replace emoji fallback with hosted paw-print logo ([25e3e60](https://github.com/Kolanupaka92/petclub-backend/commit/25e3e604e344cdb4656dab542e378604e880fcd4))

# [1.2.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.1.1...v1.2.0) (2026-05-23)


### Features

* **email:** centralized email service + 5 branded HTML templates ([07874e8](https://github.com/Kolanupaka92/petclub-backend/commit/07874e8a467f1598d285d049fff41822d65fd99e)), closes [#f97316](https://github.com/Kolanupaka92/petclub-backend/issues/f97316)

## [1.1.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.1.0...v1.1.1) (2026-05-22)


### Bug Fixes

* **auth:** friendlier Twilio trial-account error — direct users to Email OTP ([9dd7da4](https://github.com/Kolanupaka92/petclub-backend/commit/9dd7da4121f521fd68d60cae7d72411ff62b2762))

# [1.1.0](https://github.com/Kolanupaka92/petclub-backend/compare/v1.0.2...v1.1.0) (2026-05-22)


### Features

* replace Firebase phone auth with backend Twilio SMS OTP ([4b2b02b](https://github.com/Kolanupaka92/petclub-backend/commit/4b2b02b03925cc80dd89748ba4a43ba86e258d4e))

## [1.0.2](https://github.com/Kolanupaka92/petclub-backend/compare/v1.0.1...v1.0.2) (2026-05-22)


### Bug Fixes

* complete E2E QA — tracking, dispatch, status sync ([0348d21](https://github.com/Kolanupaka92/petclub-backend/commit/0348d213349a1ddc089b9266dca71862d0c5199b))

## [1.0.1](https://github.com/Kolanupaka92/petclub-backend/compare/v1.0.0...v1.0.1) (2026-05-22)


### Bug Fixes

* **admin:** wrap admin_logs insert in try/catch — Supabase v2 builder has no .catch() ([e5e8b9c](https://github.com/Kolanupaka92/petclub-backend/commit/e5e8b9c5d49158deba8412fe7b7f7150b37e1edc))

# 1.0.0 (2026-05-22)


### Bug Fixes

* add localhost origins to CORS allowed list for dev testing ([081f1d6](https://github.com/Kolanupaka92/petclub-backend/commit/081f1d63170e0646c2d7031069ee7416b5156756))
* add POST alias for admin user edit (proxy-safe against PATCH blocking) ([d8ca316](https://github.com/Kolanupaka92/petclub-backend/commit/d8ca316cd44f9e2fa68f5b0d4e6e56d4bd873f8c))
* **adminSeed:** always purge stale duplicate users regardless of email match state ([15e42ef](https://github.com/Kolanupaka92/petclub-backend/commit/15e42ef89248bf1df0a278f1447fa7ca1280940f))
* **adminSeed:** delete stale pending_role duplicate before linking admin email ([09f9cf5](https://github.com/Kolanupaka92/petclub-backend/commit/09f9cf516abc1102eee7ea6f2b830ad5470ee73a))
* **admin:** wrap payment_logs query in Promise.resolve() for .catch() ([2744d15](https://github.com/Kolanupaka92/petclub-backend/commit/2744d15e6972b73d3c85706f88ec0f85e0d44c85))
* **audit:** replace hardcoded support email in HTML template, expand .env.example ([6bca9ee](https://github.com/Kolanupaka92/petclub-backend/commit/6bca9ee7aad67fe0f4becb925c0cf69d34c86207))
* await email OTP for India (+91) and surface delivery errors ([7d52db4](https://github.com/Kolanupaka92/petclub-backend/commit/7d52db402e22d28cffe4d2a4a760e77fb5f00deb))
* backend email check uses .pop() for TLD, never flags .com ([eefd3fa](https://github.com/Kolanupaka92/petclub-backend/commit/eefd3fad2c7ca2a1e7858535cf708c4b6f32e0af))
* backend email TLD typo block catches .conm .cmo .ocm variants ([7f05ac9](https://github.com/Kolanupaka92/petclub-backend/commit/7f05ac9c4c16ae3a71aaba6c34ca5326d54b216c))
* **ci:** skip Cloud Run deploy on semantic-release version-bump commits ([9451e17](https://github.com/Kolanupaka92/petclub-backend/commit/9451e177e8ae1507f91bd10e98b1e1ae18303564))
* **deps:** regenerate package-lock.json to include semantic-release packages ([2c7e3b0](https://github.com/Kolanupaka92/petclub-backend/commit/2c7e3b0393874769fb115d93f6914aedf6500bf9))
* email typo block + GPS coords on profile update (PUT /api/users/me) ([f25f9a4](https://github.com/Kolanupaka92/petclub-backend/commit/f25f9a4ec12a579cf0f09ec3c613fd63aa4b2bdb))
* infer country and city from phone/request in set-role ([89fe25d](https://github.com/Kolanupaka92/petclub-backend/commit/89fe25de9f8e6466d1e75106ed36b9c98cb5ac85))
* remove .env from tracking, add .env.example ([b9880b0](https://github.com/Kolanupaka92/petclub-backend/commit/b9880b08d9c95739749c786cacf15933feb5aa09))
* replace broken App Store/Play Store links with working web app URL ([e503ead](https://github.com/Kolanupaka92/petclub-backend/commit/e503ead275c0d154d393391decabb3ddad9ebc55))
* replace Supabase PromiseLike .catch() chains with proper try/catch ([dd8e8de](https://github.com/Kolanupaka92/petclub-backend/commit/dd8e8de1a7748710852c4bce5614a5905f1f7605))
* **security:** comprehensive audit — eliminate all critical vulnerabilities ([a581782](https://github.com/Kolanupaka92/petclub-backend/commit/a5817823d9ff6375199e1ce7ad66229aab78b59f))
* seed ADMIN_EMAIL onto admin user record at startup ([ba1c3ae](https://github.com/Kolanupaka92/petclub-backend/commit/ba1c3aefcf487fe5ab5a65a64d54cdc860a9de17))
* update all email addresses to mypetclub.app domain ([430f346](https://github.com/Kolanupaka92/petclub-backend/commit/430f346e3be5f66948088074d3b75e147f88fe2f))
* use Mappls Static Key directly (no OAuth2 token exchange needed) ([567aaef](https://github.com/Kolanupaka92/petclub-backend/commit/567aaefc15043c53e3042dda5390aa84cace8cf4))


### Features

* 30/70 revenue split — DB columns, secure API, earnings endpoint ([96fc048](https://github.com/Kolanupaka92/petclub-backend/commit/96fc048bc099264e37b90d566255958bff3d7ba4))
* 70km GPS radius dispatch, pet health notes in pro notifications, admin email on ID upload ([c2ed5ae](https://github.com/Kolanupaka92/petclub-backend/commit/c2ed5ae1a9f6ea627d0c7a264bea5568764b0a15))
* add welcome email on user registration (set-role endpoint) ([fd4d505](https://github.com/Kolanupaka92/petclub-backend/commit/fd4d505ffe973bbb6d73a94a3f503bebe66b7b1f))
* admin bookings query includes customer name/phone for live tracking panel ([cd19ff9](https://github.com/Kolanupaka92/petclub-backend/commit/cd19ff9405b8e3b46069ff50a87d56f6b5adb5a6))
* admin OTP lookup endpoint for testing ([7feed6c](https://github.com/Kolanupaka92/petclub-backend/commit/7feed6c774f8d878ad5c2d19762d532eec147df2))
* **admin:** add DB audit + cleanup endpoints ([e8773ed](https://github.com/Kolanupaka92/petclub-backend/commit/e8773ed832c9e6b58ccb180cdbf4663a4fc32bd6))
* **admin:** add DELETE /api/admin/users/suspended/purge-all endpoint ([e7f01be](https://github.com/Kolanupaka92/petclub-backend/commit/e7f01bef076de7711bd874e7e6ac2f4d54c5b3c1))
* email OTP fallback, ID photo upload endpoint, pet creation on signup ([6bb6abb](https://github.com/Kolanupaka92/petclub-backend/commit/6bb6abb9e4d06bf8d8f049cd1fc02b53308e0fd6))
* Gmail SMTP — send OTP to any user email address ([bc6a98a](https://github.com/Kolanupaka92/petclub-backend/commit/bc6a98a0187cec2d1bffc04d193c1bef71f08a43))
* Location Gateway — routes geocoding by country (Phase 1) ([8f61685](https://github.com/Kolanupaka92/petclub-backend/commit/8f61685cf1c5352dabb685b2e89a16e200d62468))
* On My Way endpoint, 10-min proximity alert, availability email, admin user edit ([caceb26](https://github.com/Kolanupaka92/petclub-backend/commit/caceb261cb16589970e46d546bb6954ff6a6e734))
* OTP always sent to user's own email + admin copy ([1d8b50d](https://github.com/Kolanupaka92/petclub-backend/commit/1d8b50dc5db14bf9d2b77c70cd8745b0fb3628e6))
* Pet Food & Boarding inquiry emails + admin notification ([864ca6b](https://github.com/Kolanupaka92/petclub-backend/commit/864ca6b7c00c6dcf92da1aec6ab36c01bda382e9))
* pet_types specialization field for professionals, pet_types migration ([616a51c](https://github.com/Kolanupaka92/petclub-backend/commit/616a51cb8a269aca5e758c35eee925d5a1b17f22))
* PETclub backend API v1 - Express + Supabase + Twilio ([feb37f7](https://github.com/Kolanupaka92/petclub-backend/commit/feb37f7da4979158918ec91fceb602f63f813a65))
* **release:** add semantic-release CI/CD and version in health endpoint ([5ede8cf](https://github.com/Kolanupaka92/petclub-backend/commit/5ede8cf4b3f739c1d275cc34cb3ab632fc23c06b))
* replace Resend with Zoho SMTP (nodemailer) for all transactional email ([ab2e351](https://github.com/Kolanupaka92/petclub-backend/commit/ab2e3513b920b26d9362fb83731a243230428ebb))
* save GPS coordinates for addresses in profiles and bookings ([0ed7530](https://github.com/Kolanupaka92/petclub-backend/commit/0ed7530931bfb48e00687cfbc77488a65965de73))
* TESTING_RELAY_EMAIL - relay all OTPs to admin during beta ([837328a](https://github.com/Kolanupaka92/petclub-backend/commit/837328a50ae588f5addb2ce08686c4395801e0ae))
