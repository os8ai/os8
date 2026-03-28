/**
 * System clock for OS8 header
 * Uses configured timezone from Settings
 */

let cachedTimezone = null;

async function fetchTimezone() {
  try {
    const serverPort = await window.os8.server.getPort();
    const res = await fetch(`http://localhost:${serverPort}/api/settings/time`);
    const data = await res.json();
    cachedTimezone = data.timezone || 'America/New_York';
  } catch (err) {
    cachedTimezone = 'America/New_York';
  }
}

function updateSystemClock() {
  const tz = cachedTimezone || 'America/New_York';
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(now);

  const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
  const display = `${get('weekday')} ${get('month')} ${get('day')}  ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;

  const headerClock = document.getElementById('headerClock');
  if (headerClock) {
    headerClock.textContent = display;
  }
}

export function startClock() {
  fetchTimezone().then(() => {
    updateSystemClock();
    setInterval(updateSystemClock, 1000);
  });

  // Listen for timezone changes from settings
  window.addEventListener('os8:timezone-changed', (e) => {
    cachedTimezone = e.detail.timezone;
    updateSystemClock();
  });
}
