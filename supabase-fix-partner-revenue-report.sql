-- Fix: partner_revenue_report joined users on b.professional_id, but that
-- column references professional_profiles.id — the join never matched and
-- the admin Revenue Report always returned empty. Route through the profile.
-- Applied to production 2026-07-02.
CREATE OR REPLACE FUNCTION partner_revenue_report(
  p_from DATE DEFAULT '2000-01-01',
  p_to   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  professional_id   UUID,
  professional_name TEXT,
  sub_role          TEXT,
  total_bookings    BIGINT,
  total_revenue     NUMERIC,
  provider_earnings NUMERIC,
  platform_fee      NUMERIC,
  gateway_fee       NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    b.professional_id,
    u.name                                    AS professional_name,
    pp.sub_role,
    COUNT(*)                                  AS total_bookings,
    ROUND(SUM(COALESCE(b.total_amount, b.amount, 0))::numeric, 2) AS total_revenue,
    ROUND(SUM(COALESCE(b.provider_earnings, 0))::numeric, 2)      AS provider_earnings,
    ROUND(SUM(COALESCE(b.platform_fee, 0))::numeric, 2)           AS platform_fee,
    ROUND(SUM(COALESCE(b.gateway_fee, 0))::numeric, 2)            AS gateway_fee
  FROM bookings b
  JOIN professional_profiles pp ON pp.id = b.professional_id
  JOIN users u                  ON u.id  = pp.user_id
  WHERE b.status = 'completed'
    AND b.deleted_at IS NULL
    AND b.created_at::date BETWEEN p_from AND p_to
    AND b.professional_id IS NOT NULL
  GROUP BY b.professional_id, u.name, pp.sub_role
  ORDER BY total_revenue DESC;
$$;
