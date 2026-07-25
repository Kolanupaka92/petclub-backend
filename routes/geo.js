// ══════════════════════════════════════════════════════════════════
//  Geo routes — forward + reverse geocoding
//
//  First extraction of the modular-monolith refactor (see routes/README.md).
//  Exports a router FACTORY so it receives server.js's singletons
//  (supabase, logger, auth middleware) via dependency injection instead
//  of reaching into module globals. This lets routes move out of the
//  5,700-line server.js one cohesive domain at a time, with no big-bang.
//
//  Provider strategy: India (+91) → Mappls, everyone else → Nominatim
//  (OSM). Nominatim is always the fallback so geocoding never hard-fails.
// ══════════════════════════════════════════════════════════════════
'use strict';

const express = require('express');

module.exports = function createGeoRouter({ supabase, logger, auth, supportEmail }) {
  const router = express.Router();

  const ua = () => `PETclub/1.0 ${process.env.NOMINATIM_CONTACT || supportEmail}`;

  // Mappls Cloud App issues a Static Key used directly as access_token — no OAuth.
  const getMapplsToken = async () => process.env.MAPPLS_STATIC_KEY || null;

  const getGeoProvider = (phone = '') => {
    if (phone.startsWith('+91')) return 'mappls';
    // Phase 2: if (phone.startsWith('+1')) return 'google';
    return 'nominatim';
  };

  const searchMappls = async (q, token) => {
    const url = `https://atlas.mappls.com/api/places/search/json`
      + `?query=${encodeURIComponent(q)}&region=IND&access_token=${token}`;
    const d = await fetch(url).then(r => r.json());
    return (d.suggestedLocations || []).map((f, i) => ({
      id:         f.eLoc || i,
      short:      f.placeName  || '',
      full:       [f.placeName, f.placeAddress].filter(Boolean).join(', '),
      lat:        parseFloat(f.latitude)  || null,
      lng:        parseFloat(f.longitude) || null,
      postalCode: f.pincode || '',
      city:       f.city    || '',
      state:      f.state   || '',
    }));
  };

  const reverseMappls = async (lat, lng, token) => {
    const url = `https://atlas.mappls.com/api/places/geo_code`
      + `?lat=${lat}&lng=${lng}&access_token=${token}`;
    const d = await fetch(url).then(r => r.json());
    const r = d.results?.[0] || d.copResults || null;
    if (!r) return null;
    const full = r.formattedAddress
      || [r.houseNumber, r.houseName, r.street, r.subLocality,
          r.locality, r.city, r.state, r.pincode].filter(Boolean).join(', ');
    return { full, postalCode: r.pincode || '', city: r.city || r.district || '', state: r.state || '' };
  };

  const searchNominatim = async (q) => {
    const url = `https://nominatim.openstreetmap.org/search`
      + `?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6&accept-language=en`;
    const d = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': ua() } }).then(r => r.json());
    return (d || []).map((f, i) => {
      const a = f.address || {};
      return {
        id:         f.place_id || i,
        short:      (f.display_name || '').split(', ')[0],
        full:       f.display_name,
        lat:        parseFloat(f.lat),
        lng:        parseFloat(f.lon),
        postalCode: a.postcode || '',
        city:       a.city || a.town || a.village || a.county || '',
        state:      a.state || '',
      };
    });
  };

  const reverseNominatim = async (lat, lng) => {
    const url = `https://nominatim.openstreetmap.org/reverse`
      + `?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&accept-language=en`;
    const d = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': ua() } }).then(r => r.json());
    const a = d.address || {};
    return {
      full:       d.display_name || '',
      postalCode: a.postcode || '',
      city:       a.city || a.town || a.village || a.county || '',
      state:      a.state || '',
    };
  };

  //  GET /api/geocode?q=...
  router.get('/geocode', auth, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 3) return res.json([]);
    try {
      const { data: u } = await supabase.from('users').select('phone').eq('id', req.user.id).single();
      const provider = getGeoProvider(u?.phone || '');
      let results = [];
      if (provider === 'mappls') {
        const token = await getMapplsToken();
        if (token) {
          try { results = await searchMappls(q, token); } catch (e) {
            logger.warn('[Mappls] search failed, falling back to Nominatim:', e.message);
          }
        }
      }
      if (!results.length) results = await searchNominatim(q); // always fallback
      res.json(results);
    } catch (e) {
      logger.error('[geocode]', e.message);
      try { res.json(await searchNominatim(q)); } catch { res.json([]); }
    }
  });

  //  GET /api/reverse-geocode?lat=...&lng=...
  router.get('/reverse-geocode', auth, async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
    try {
      const { data: u } = await supabase.from('users').select('phone').eq('id', req.user.id).single();
      const provider = getGeoProvider(u?.phone || '');
      let result = null;
      if (provider === 'mappls') {
        const token = await getMapplsToken();
        if (token) {
          try { result = await reverseMappls(lat, lng, token); } catch (e) {
            logger.warn('[Mappls] reverse failed, falling back to Nominatim:', e.message);
          }
        }
      }
      if (!result) result = await reverseNominatim(lat, lng);
      res.json(result || {});
    } catch (e) {
      logger.error('[reverse-geocode]', e.message);
      try { res.json(await reverseNominatim(lat, lng)); } catch { res.json({}); }
    }
  });

  return router;
};
