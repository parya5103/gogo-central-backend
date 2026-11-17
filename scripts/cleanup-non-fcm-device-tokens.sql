-- GoGo Central: remove non-FCM test tokens from Neon PostgreSQL.
-- The worker also runs equivalent automatic cleanup before production sends
-- whenever NODE_ENV=production and FCM_DRY_RUN is not 'true'.
-- Review the affected rows first with the SELECT statement below.

-- SELECT device_id, app_id, platform, left(fcm_token, 24) AS token_preview
-- FROM device_tokens
-- WHERE left(fcm_token, 4) = 'fcm_'
--    OR left(ltrim(fcm_token), 1) IN ('{', '[')
--    OR length(fcm_token) <= 100;

BEGIN;

DELETE FROM device_tokens
WHERE left(fcm_token, 4) = 'fcm_'
   OR left(ltrim(fcm_token), 1) IN ('{', '[')
   OR length(fcm_token) <= 100;

COMMIT;
