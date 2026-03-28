const express = require('express');
const SettingsService = require('../services/settings');

/**
 * Get the configured timezone (defaults to America/New_York)
 * @param {object} db - SQLite database instance (optional)
 * @returns {string} IANA timezone string
 */
function getConfiguredTimezone(db) {
  if (!db) return 'America/New_York';
  return SettingsService.get(db, 'timezone') || 'America/New_York';
}

/**
 * Get system time - single source of truth for OS8
 * Used by the API and internal services (job scheduler, etc.)
 * @param {object} [db] - SQLite database instance for reading timezone setting
 * @returns {{ now: Date, unix: number, iso: string, timezone: string, offset: number }}
 */
function getSystemTime(db) {
  const now = new Date();
  const timezone = getConfiguredTimezone(db);
  return {
    now,
    unix: Math.floor(now.getTime() / 1000),
    iso: now.toISOString(),
    timezone,
    offset: now.getTimezoneOffset()
  };
}

function createSystemRouter(db) {
  const router = express.Router();

  // Get current system time (available to all apps)
  router.get('/time', (req, res) => {
    try {
      const time = getSystemTime(db);
      const tz = time.timezone;

      // Various formats for different use cases
      const timeOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: tz };
      const shortOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz };

      res.json({
        iso: time.iso,
        unix: time.unix,
        formatted: time.now.toLocaleString('en-US', timeOptions),
        short: time.now.toLocaleString('en-US', shortOptions),
        timezone: tz,
        offset: time.offset
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSystemRouter;
module.exports.getSystemTime = getSystemTime;
module.exports.getConfiguredTimezone = getConfiguredTimezone;
