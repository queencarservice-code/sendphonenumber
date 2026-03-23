/**
 * Send Phone Numbers to Phone Dispatchers
 *
 * Polls the PBX active-calls API, deduplicates concurrent ring legs that
 * share the same orig_id (i.e. one inbound call ringing multiple registered
 * phones/extensions simultaneously), and forwards a single notification per
 * unique call to the configured dispatcher endpoints.
 */

'use strict';

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

// ── Configuration (override via environment variables) ─────────────────────

const CONFIG = {
  /** URL of the PBX active-calls JSON API */
  pbxApiUrl: process.env.PBX_API_URL || '',

  /** Bearer token for the PBX API */
  pbxBearerToken: process.env.PBX_BEARER_TOKEN || '',

  /** Comma-separated list of dispatcher webhook URLs */
  dispatcherWebhooks: (process.env.DISPATCHER_WEBHOOKS || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),

  /** How often to poll for new calls, in milliseconds */
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '500', 10),
};

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Set of orig_ids we have already notified dispatchers about.
 * Cleared when a call disappears from the active list.
 */
const notifiedCalls = new Set();

/**
 * Calls seen in the previous poll but not yet notified (e.g. appeared and
 * disappeared within a single poll interval before we could send).
 * @type {Map<string, Object>}
 */
const pendingCalls = new Map();

const emitter = new EventEmitter();

// ── Deduplication logic ────────────────────────────────────────────────────

/**
 * Deduplicate an array of raw call-leg objects (as returned by the PBX API)
 * into one entry per unique orig_id.
 *
 * Each raw call-leg is expected to have at minimum:
 *   { orig_id, from, caller_id, dialed, to, gmt_start }
 *
 * @param {Object[]} callLegs - Raw call legs from the PBX API
 * @returns {Map<string, Object>} - Deduplicated calls keyed by orig_id
 */
function deduplicateCallLegs(callLegs) {
  const callMap = new Map();

  for (const leg of callLegs) {
    const origId = leg.orig_id;
    if (!origId) continue;

    if (callMap.has(origId)) {
      // Merge ringing extensions for the same call
      callMap.get(origId).ringingExtensions.push(leg.to);
    } else {
      callMap.set(origId, {
        origId,
        from: leg.from,
        callerId: leg.caller_id,
        dialed: leg.dialed,
        ringingExtensions: [leg.to],
        gmtStart: leg.gmt_start,
      });
    }
  }

  return callMap;
}

// ── Dispatcher notification ────────────────────────────────────────────────

/**
 * Send a call notification to a single dispatcher webhook URL.
 *
 * @param {string} webhookUrl
 * @param {Object} call - Deduplicated call object
 * @returns {Promise<void>}
 */
function notifyDispatcher(webhookUrl, call) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      event: 'incoming_call',
      orig_id: call.origId,
      from: call.from,
      caller_id: call.callerId,
      dialed: call.dialed,
      ringing_extensions: call.ringingExtensions,
      gmt_start: call.gmtStart,
    });

    const url = new URL(webhookUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      res.resume(); // drain response body
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Dispatcher responded with HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Notify all configured dispatcher webhooks about a new unique call.
 *
 * @param {Object} call - Deduplicated call object
 */
async function notifyAllDispatchers(call) {
  if (CONFIG.dispatcherWebhooks.length === 0) {
    console.warn('[sendphonenumber] No dispatcher webhooks configured.');
    return;
  }

  await Promise.allSettled(
    CONFIG.dispatcherWebhooks.map((url) =>
      notifyDispatcher(url, call).catch((err) => {
        console.error(`[sendphonenumber] Failed to notify ${url}:`, err.message);
      })
    )
  );
}

// ── PBX API polling ────────────────────────────────────────────────────────

/**
 * Parse active call legs from the PBX HTML active-calls table.
 *
 * Each <tr> with an orig_id attribute represents a call leg.
 * Columns: From, Caller ID, Dialed, To, Duration
 *
 * @param {string} html
 * @returns {Object[]}
 */
function parseCallLegsFromHtml(html) {
  const callLegs = [];
  const rowRegex = /<tr\s([^>]*orig_id="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const attrs = rowMatch[1];
    const cells = rowMatch[2];

    const origId   = (attrs.match(/orig_id="([^"]*)"/)        || [])[1];
    const gmtStart = (attrs.match(/data-gmt-start="([^"]*)"/) || [])[1];
    const gmtAnswer = (cells.match(/data-gmt-answer="([^"]*)"/) || [])[1];

    if (!origId) continue;

    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cols = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(cells)) !== null) {
      cols.push(tdMatch[1].replace(/<[^>]*>/g, '').trim());
    }

    callLegs.push({
      orig_id:    origId,
      from:       cols[0] || '',
      caller_id:  cols[1] || '',
      dialed:     cols[2] || '',
      to:         cols[3] || '',
      gmt_start:  gmtStart  || '',
      gmt_answer: gmtAnswer || null,
    });
  }

  return callLegs;
}

/**
 * Fetch the current active call legs from the PBX API.
 *
 * @returns {Promise<Object[]>}
 */
function fetchActiveCallLegs() {
  return new Promise((resolve, reject) => {
    if (!CONFIG.pbxApiUrl) {
      reject(new Error('PBX_API_URL is not configured'));
      return;
    }

    const url = new URL(CONFIG.pbxApiUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Accept: 'text/html,application/json',
        ...(CONFIG.pbxBearerToken
          ? { Authorization: `Bearer ${CONFIG.pbxBearerToken}` }
          : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Try JSON first; fall back to HTML parsing
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(parseCallLegsFromHtml(data));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * One polling cycle: fetch, deduplicate, notify for new calls, prune gone calls.
 */
async function poll() {
  let callLegs;
  try {
    callLegs = await fetchActiveCallLegs();
  } catch (err) {
    console.error('[sendphonenumber] Error fetching active calls:', err.message);
    return;
  }

  const activeCalls = deduplicateCallLegs(callLegs);
  const activeOrigIds = new Set(activeCalls.keys());

  // Notify dispatchers for calls we haven't seen yet
  for (const [origId, call] of activeCalls) {
    pendingCalls.delete(origId); // it's still active, no longer pending
    if (!notifiedCalls.has(origId)) {
      console.log(
        `[sendphonenumber] New call: ${call.from} (${call.callerId}) → ${call.dialed}` +
        ` ringing [${call.ringingExtensions.join(', ')}]`
      );
      notifiedCalls.add(origId);
      emitter.emit('call', call);
      await notifyAllDispatchers(call);
    }
  }

  // Remove calls that are no longer active
  for (const origId of notifiedCalls) {
    if (!activeOrigIds.has(origId)) {
      notifiedCalls.delete(origId);
      pendingCalls.delete(origId);
      emitter.emit('call_ended', origId);
    }
  }

  // Notify calls that appeared last poll but vanished before this poll ran
  // (picked up faster than the poll interval)
  for (const [origId, call] of pendingCalls) {
    if (!activeOrigIds.has(origId)) {
      console.log(
        `[sendphonenumber] Fast-pickup call: ${call.from} (${call.callerId}) → ${call.dialed}` +
        ` ringing [${call.ringingExtensions.join(', ')}]`
      );
      notifiedCalls.add(origId);
      emitter.emit('call', call);
      await notifyAllDispatchers(call);
      pendingCalls.delete(origId);
    }
  }

  // Track newly seen calls in case they vanish next poll
  for (const [origId, call] of activeCalls) {
    if (!notifiedCalls.has(origId)) {
      pendingCalls.set(origId, call);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Schedule a clean process exit at the next 3:00 AM local time.
 * The process manager (PM2 / systemd) will restart the process,
 * refreshing the PBX session before it expires.
 */
function scheduleDailyRestart() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);

  const delay = next3am - now;
  console.log(
    `[sendphonenumber] Daily restart scheduled for ${next3am.toLocaleString()} ` +
    `(in ${Math.round(delay / 60000)} min)`
  );

  setTimeout(() => {
    console.log('[sendphonenumber] 3AM restart — refreshing PBX session.');
    process.exit(0);
  }, delay);
}

/**
 * Start polling the PBX for active calls and notifying dispatchers.
 *
 * @returns {{ stop: Function, on: Function }} - Control handle
 */
function start() {
  console.log('[sendphonenumber] Starting — polling every', CONFIG.pollIntervalMs, 'ms');

  scheduleDailyRestart();
  poll(); // immediate first run
  const timer = setInterval(poll, CONFIG.pollIntervalMs);

  return {
    stop() {
      clearInterval(timer);
      console.log('[sendphonenumber] Stopped.');
    },
    on: emitter.on.bind(emitter),
  };
}

module.exports = { start, deduplicateCallLegs, CONFIG };

// ── Run as main script ─────────────────────────────────────────────────────
if (require.main === module) {
  const service = start();

  process.on('SIGINT', () => { service.stop(); process.exit(0); });
  process.on('SIGTERM', () => { service.stop(); process.exit(0); });
}
