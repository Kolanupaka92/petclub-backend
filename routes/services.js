// ══════════════════════════════════════════════════════════════════
//  Service catalog route — customer-facing pricing
//
//  Second extraction of the modular-monolith refactor (routes/README.md).
//  Fully isolated: reads only the static pricingCatalog module; touches
//  no bookings, GPS, dispatch, or auth state beyond the injected `auth`
//  guard. Behavior-preserving move of GET /api/services/catalog.
// ══════════════════════════════════════════════════════════════════
'use strict';

const express = require('express');

module.exports = function createServicesRouter({ auth, pricingCatalog }) {
  const router = express.Router();

  //  GET /api/services/catalog — pricing catalog (customers only)
  router.get('/services/catalog', auth, (req, res) => {
    if (req.user.role === 'professional') {
      return res.status(403).json({ error: 'Service pricing is not available to providers.' });
    }
    res.setHeader('Cache-Control', 'private, max-age=3600'); // catalog changes rarely — cache 1h per user session
    const {
      PLATFORM_DISCOUNT, PLATFORM_DISCOUNT_USD, GROOMING_PACKAGES, GROOMING_ADDONS,
      PET_SIZES, TRAINING_PACKAGES, WALKING_PACKAGES, BOARDING_PACKAGES,
      VET_PACKAGES, VET_SERVICES,
    } = pricingCatalog;
    res.json({
      success: true,
      platform_discount:     PLATFORM_DISCOUNT,
      platform_discount_usd: PLATFORM_DISCOUNT_USD,
      grooming: { packages: GROOMING_PACKAGES, addons: GROOMING_ADDONS, pet_sizes: PET_SIZES },
      training: { packages: TRAINING_PACKAGES },
      walking:  { packages: WALKING_PACKAGES },
      boarding: { packages: BOARDING_PACKAGES },
      vet:      { packages: VET_PACKAGES, services: VET_SERVICES },
    });
  });

  return router;
};
