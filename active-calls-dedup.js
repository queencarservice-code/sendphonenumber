/**
 * Active Calls Deduplication
 *
 * When multiple phones/extensions are online and a call comes in, the PBX
 * creates one table row per ringing device (all sharing the same orig_id).
 * This module deduplicates those rows so dispatchers see one entry per call.
 */

'use strict';

/**
 * Parse active call rows from the calls_table DOM element.
 * Returns an array of call objects keyed by orig_id.
 *
 * @param {HTMLElement} table - The #calls_table element
 * @returns {Map<string, Object>} - Map of orig_id -> deduplicated call
 */
function parseActiveCalls(table) {
  const rows = table.querySelectorAll('tbody tr');
  const callMap = new Map();

  rows.forEach((row) => {
    const origId = row.getAttribute('orig_id');
    if (!origId) return;

    const cells = row.querySelectorAll('td');
    if (cells.length < 5) return;

    const from = cells[0].textContent.trim();
    const callerId = cells[1].textContent.trim();
    const dialed = cells[2].textContent.trim();
    const to = cells[3].textContent.trim();
    const durationEl = cells[4].querySelector('.duration_counter');
    const gmtStart = durationEl ? durationEl.getAttribute('data-gmt-start') : null;

    if (callMap.has(origId)) {
      // Merge: add this extension to the ringing list
      callMap.get(origId).ringingExtensions.push(to);
    } else {
      callMap.set(origId, {
        origId,
        from,
        callerId,
        dialed,
        ringingExtensions: [to],
        gmtStart,
        termId: row.getAttribute('term_id'),
        termUri: row.getAttribute('term_uri'),
      });
    }
  });

  return callMap;
}

/**
 * Deduplicate the calls_table so each orig_id appears only once.
 * The "To" column is updated to show all ringing extensions (e.g. "301, 302, 303").
 *
 * @param {HTMLElement} table - The #calls_table element
 */
function deduplicateCallsTable(table) {
  const callMap = parseActiveCalls(table);
  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  // Remove all existing rows
  tbody.innerHTML = '';

  // Re-render one row per unique call
  callMap.forEach((call) => {
    const extensionsDisplay = call.ringingExtensions.join(', ');
    const tr = document.createElement('tr');
    tr.setAttribute('orig_id', call.origId);
    if (call.termId) tr.setAttribute('term_id', call.termId);
    if (call.termUri) tr.setAttribute('term_uri', call.termUri);

    tr.innerHTML = `
      <td>${escapeHtml(call.from)}</td>
      <td>${escapeHtml(call.callerId)}</td>
      <td>${escapeHtml(call.dialed)}</td>
      <td>${escapeHtml(extensionsDisplay)}</td>
      <td class="text-right">
        <span data-gmt-start="${escapeHtml(call.gmtStart || '')}"
              data-gmt-answer="0000-00-00 00:00:00"
              class="duration_counter">00:00</span>
      </td>
      <td class="action-buttons"><div class="action-buttons-inner">&nbsp;</div></td>
    `;

    tbody.appendChild(tr);
  });
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Node.js / CommonJS export ──────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseActiveCalls, deduplicateCallsTable, escapeHtml };
}
