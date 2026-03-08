'use strict';

const { deduplicateCallLegs } = require('./send-phone-number');

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Simulates the call legs produced by the PBX when one inbound call rings
 * six extensions simultaneously (301-306).
 */
const multiPhoneLegs = [
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '305', gmt_start: '2026-03-08 15:40:11' },
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '306', gmt_start: '2026-03-08 15:40:11' },
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '304', gmt_start: '2026-03-08 15:40:11' },
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '303', gmt_start: '2026-03-08 15:40:11' },
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '302', gmt_start: '2026-03-08 15:40:11' },
  { orig_id: '359145098_50322806@206.146.104.8', from: '1 (347) 221-5062', caller_id: 'STEVEN YANG', dialed: '1 (718) 762-3333', to: '301', gmt_start: '2026-03-08 15:40:11' },
];

const twoDistinctCalls = [
  { orig_id: 'call-A@pbx', from: '1 (212) 555-0001', caller_id: 'ALICE',   dialed: '1 (718) 762-3333', to: '301', gmt_start: '2026-03-08 15:00:00' },
  { orig_id: 'call-A@pbx', from: '1 (212) 555-0001', caller_id: 'ALICE',   dialed: '1 (718) 762-3333', to: '302', gmt_start: '2026-03-08 15:00:00' },
  { orig_id: 'call-B@pbx', from: '1 (646) 555-0002', caller_id: 'BOB',     dialed: '1 (718) 762-3333', to: '303', gmt_start: '2026-03-08 15:01:00' },
];

// ── Tests ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

// Test 1: Six legs for the same call dedup to one entry
console.log('\nTest: six simultaneous ring legs deduplicate to one call');
{
  const result = deduplicateCallLegs(multiPhoneLegs);
  assert(result.size === 1, 'Map has exactly one entry');

  const call = result.get('359145098_50322806@206.146.104.8');
  assert(call !== undefined, 'Entry is keyed by orig_id');
  assert(call.from === '1 (347) 221-5062', 'from is preserved');
  assert(call.callerId === 'STEVEN YANG', 'callerId is preserved');
  assert(call.dialed === '1 (718) 762-3333', 'dialed is preserved');
  assert(call.ringingExtensions.length === 6, 'all 6 extensions collected');
  assert(
    ['301','302','303','304','305','306'].every(ext => call.ringingExtensions.includes(ext)),
    'extensions 301-306 all present'
  );
}

// Test 2: Two distinct calls stay separate; one with two legs
console.log('\nTest: two distinct calls with shared extensions');
{
  const result = deduplicateCallLegs(twoDistinctCalls);
  assert(result.size === 2, 'Map has two entries');

  const callA = result.get('call-A@pbx');
  assert(callA.ringingExtensions.length === 2, 'call-A has 2 ringing extensions');
  assert(callA.ringingExtensions.includes('301'), 'call-A includes ext 301');
  assert(callA.ringingExtensions.includes('302'), 'call-A includes ext 302');

  const callB = result.get('call-B@pbx');
  assert(callB.ringingExtensions.length === 1, 'call-B has 1 ringing extension');
  assert(callB.ringingExtensions[0] === '303', 'call-B ext is 303');
}

// Test 3: Empty input
console.log('\nTest: empty call-legs array');
{
  const result = deduplicateCallLegs([]);
  assert(result.size === 0, 'Empty input yields empty map');
}

// Test 4: Legs missing orig_id are skipped
console.log('\nTest: legs without orig_id are ignored');
{
  const result = deduplicateCallLegs([
    { orig_id: '', from: 'X', caller_id: 'X', dialed: 'X', to: '301', gmt_start: '' },
    { from: 'Y', caller_id: 'Y', dialed: 'Y', to: '302', gmt_start: '' },
    { orig_id: 'valid@pbx', from: '1 (212) 555-0099', caller_id: 'Z', dialed: '1 (718) 762-3333', to: '301', gmt_start: '' },
  ]);
  assert(result.size === 1, 'Only the leg with a valid orig_id is included');
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
