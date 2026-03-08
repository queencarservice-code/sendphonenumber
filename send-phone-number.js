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
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
};

// ── State ──────────────────────────────────────────────────────────────────

/**
 * Set of orig_ids we have already notified dispatchers about.
 * Cleared when a call disappears from the active list.
 */
const notifiedCalls = new Set();

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
        Accept: 'application/json',
        ...(CONFIG.pbxBearerToken
          ? { Authorization: `Bearer ${CONFIG.pbxBearerToken}` }
          : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from PBX API'));
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
      emitter.emit('call_ended', origId);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start polling the PBX for active calls and notifying dispatchers.
 *
 * @returns {{ stop: Function, on: Function }} - Control handle
 */
function start() {
  console.log('[sendphonenumber] Starting — polling every', CONFIG.pollIntervalMs, 'ms');

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
