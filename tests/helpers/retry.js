// Author: Sai Kolanupaka
'use strict';
// CI only: one retry so a dropped local socket can't block a deploy. Real failures fail twice.
if (process.env.CI) jest.retryTimes(1, { logErrorsBeforeRetry: true });
