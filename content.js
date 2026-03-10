/**
 * Google Meeting Cost Calculator – Content Script
 *
 * Observes Google Calendar for event detail pop-ups and injects a cost
 * summary section showing single-meeting, monthly, and yearly costs.
 */

const DEFAULT_COST_PER_HOUR = 50;
const INJECTION_MARKER = 'data-gmc-injected';

// ─── Settings ────────────────────────────────────────────────────────────────

let costPerPersonPerHour = DEFAULT_COST_PER_HOUR;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ costPerPersonPerHour: DEFAULT_COST_PER_HOUR }, (items) => {
      costPerPersonPerHour = parseFloat(items.costPerPersonPerHour) || DEFAULT_COST_PER_HOUR;
      resolve();
    });
  });
}

// Keep settings fresh when the user changes them in popup/options
chrome.storage.onChanged.addListener((changes) => {
  if (changes.costPerPersonPerHour) {
    costPerPersonPerHour = parseFloat(changes.costPerPersonPerHour.newValue) || DEFAULT_COST_PER_HOUR;
    // Re-inject any currently open popup with updated values
    document.querySelectorAll(`[${INJECTION_MARKER}]`).forEach((el) => {
      el.removeAttribute(INJECTION_MARKER);
      const existing = el.querySelector('.gmc-cost-section');
      if (existing) existing.remove();
      processPopup(el);
    });
  }
});

// ─── Duration Parsing ────────────────────────────────────────────────────────

/**
 * Parses a time string like "2:00 PM", "14:00", "2 PM", etc. into minutes
 * since midnight.
 */
function parseTimeToMinutes(timeStr) {
  timeStr = timeStr.trim();

  // Try 12-hour format with AM/PM: "2:30 PM", "2 PM"
  const match12 = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = parseInt(match12[2] || '0', 10);
    const period = match12[3].toUpperCase();
    if (period === 'AM' && hours === 12) hours = 0;
    if (period === 'PM' && hours !== 12) hours += 12;
    return hours * 60 + minutes;
  }

  // Try 24-hour format: "14:30"
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    return parseInt(match24[1], 10) * 60 + parseInt(match24[2], 10);
  }

  return null;
}

/**
 * Extracts meeting duration (in hours) from all text inside a dialog element.
 * Google Calendar displays times like "2:00 PM – 3:00 PM" or "10:00 – 11:30".
 * Returns null if parsing fails.
 */
function extractDuration(dialogEl) {
  // Search all text nodes for a time-range pattern
  const timeRangeRegex = /(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[–\-]\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/gi;

  const walker = document.createTreeWalker(dialogEl, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (!text) continue;
    const match = timeRangeRegex.exec(text);
    if (match) {
      const startMin = parseTimeToMinutes(match[1].trim());
      const endMin = parseTimeToMinutes(match[2].trim());
      if (startMin !== null && endMin !== null) {
        let diff = endMin - startMin;
        if (diff < 0) diff += 24 * 60; // handle midnight wrap
        if (diff > 0) return diff / 60;
      }
    }
    // Reset lastIndex for global regex
    timeRangeRegex.lastIndex = 0;
  }

  // Also try aria-label on the time element
  const timeEl = dialogEl.querySelector('[data-start-time], [data-endtime], [jsname="r4nke"]');
  if (timeEl) {
    const label = timeEl.getAttribute('aria-label') || timeEl.textContent || '';
    const match = timeRangeRegex.exec(label);
    if (match) {
      const startMin = parseTimeToMinutes(match[1].trim());
      const endMin = parseTimeToMinutes(match[2].trim());
      if (startMin !== null && endMin !== null) {
        let diff = endMin - startMin;
        if (diff < 0) diff += 24 * 60;
        if (diff > 0) return diff / 60;
      }
    }
  }

  return null;
}

// ─── Attendee Extraction ─────────────────────────────────────────────────────

/**
 * Counts the number of attendees (including organizer) from the event dialog.
 * Returns at least 1.
 */
function extractAttendeeCount(dialogEl) {
  // Strategy 1: count elements with [data-attendee-id]
  const byAttendeeId = dialogEl.querySelectorAll('[data-attendee-id]');
  if (byAttendeeId.length > 0) return byAttendeeId.length;

  // Strategy 2: look for "X guests" text
  const guestRegex = /(\d+)\s+guests?/i;
  const walker = document.createTreeWalker(dialogEl, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    const match = node.textContent.match(guestRegex);
    if (match) {
      // "X guests" usually means X invitees; add 1 for organizer if needed,
      // but most interpretations count organizer in the list already.
      return parseInt(match[1], 10);
    }
  }

  // Strategy 3: count list items inside an attendee container
  // Google Calendar wraps attendees in a scrollable list; look for aria-label hints
  const sections = dialogEl.querySelectorAll('[aria-label]');
  for (const section of sections) {
    const label = (section.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('guest') || label.includes('attendee') || label.includes('invited')) {
      const items = section.querySelectorAll('[role="listitem"], li');
      if (items.length > 0) return items.length;
    }
  }

  // Strategy 4: count avatar/chip elements that represent people
  const avatars = dialogEl.querySelectorAll('[data-hovercard-id], [data-email]');
  if (avatars.length > 0) return avatars.length;

  return 1; // fallback: just the organizer
}

// ─── Recurrence Detection ────────────────────────────────────────────────────

const RECURRENCE_PATTERNS = [
  { regex: /every\s+weekday/i, occPerMonth: 22 },
  { regex: /every\s+day|daily/i, occPerMonth: 30 },
  { regex: /every\s+(\d+)\s+weeks?/i, occPerMonth: null }, // handled below
  { regex: /every\s+other\s+week|bi[\s-]?weekly|every\s+2\s+weeks?/i, occPerMonth: 2.17 },
  { regex: /every\s+week|weekly/i, occPerMonth: 4.33 },
  { regex: /every\s+(\d+)\s+months?/i, occPerMonth: null }, // handled below
  { regex: /every\s+month|monthly/i, occPerMonth: 1 },
  { regex: /every\s+year|annually|yearly/i, occPerMonth: 1 / 12 },
];

/**
 * Detects whether the event is recurring and returns { isRecurring, recurrenceText, occurrencesPerMonth }.
 */
function extractRecurrence(dialogEl) {
  // Check aria-labels for "recurring" / "repeat" keywords
  const allElements = dialogEl.querySelectorAll('*');
  let recurrenceText = '';

  for (const el of allElements) {
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('recurring') || ariaLabel.includes('repeat')) {
      recurrenceText = el.getAttribute('aria-label');
      break;
    }
  }

  // Walk text nodes to find recurrence description like "Every week on Tuesday"
  const walker = document.createTreeWalker(dialogEl, NodeFilter.SHOW_TEXT, null, false);
  let node;
  const candidateTexts = [];
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (/every|daily|weekly|monthly|annually|yearly|weekday/i.test(text)) {
      candidateTexts.push(text);
      if (!recurrenceText) recurrenceText = text;
    }
  }

  const fullText = [recurrenceText, ...candidateTexts].join(' ');

  if (!fullText.trim()) {
    return { isRecurring: false, recurrenceText: '', occurrencesPerMonth: 0 };
  }

  // Match against known patterns
  for (const pattern of RECURRENCE_PATTERNS) {
    const match = pattern.regex.exec(fullText);
    if (match) {
      let occ = pattern.occPerMonth;

      // Handle "every N weeks"
      if (occ === null && /every\s+(\d+)\s+weeks?/i.test(pattern.regex.source)) {
        const nMatch = /every\s+(\d+)\s+weeks?/i.exec(fullText);
        const n = nMatch ? parseInt(nMatch[1], 10) : 1;
        occ = 4.33 / n;
      }

      // Handle "every N months"
      if (occ === null && /every\s+(\d+)\s+months?/i.test(pattern.regex.source)) {
        const nMatch = /every\s+(\d+)\s+months?/i.exec(fullText);
        const n = nMatch ? parseInt(nMatch[1], 10) : 1;
        occ = 1 / n;
      }

      if (occ === null) occ = 4.33; // safe fallback

      return {
        isRecurring: true,
        recurrenceText: recurrenceText || candidateTexts[0] || '',
        occurrencesPerMonth: occ,
      };
    }
  }

  // recurrenceText was set but no pattern matched → still treat as recurring
  if (recurrenceText) {
    return { isRecurring: true, recurrenceText, occurrencesPerMonth: 4.33 };
  }

  return { isRecurring: false, recurrenceText: '', occurrencesPerMonth: 0 };
}

// ─── Cost Injection ───────────────────────────────────────────────────────────

function formatCurrency(amount) {
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatHours(h) {
  if (h === 1) return '1 hr';
  if (Number.isInteger(h)) return `${h} hrs`;
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  if (hrs === 0) return `${mins} min`;
  return `${hrs} hr ${mins} min`;
}

function buildCostSection(data) {
  const { attendees, durationHours, isRecurring, recurrenceText, occurrencesPerMonth, singleCost, monthlyCost, yearlyCost, rate } = data;

  const section = document.createElement('div');
  section.className = 'gmc-cost-section';

  // Title row
  const titleRow = document.createElement('div');
  titleRow.className = 'gmc-title-row';
  titleRow.innerHTML = `
    <span class="gmc-icon" aria-hidden="true">💰</span>
    <span class="gmc-title">Meeting Cost</span>
  `;
  section.appendChild(titleRow);

  // Main cost card
  const card = document.createElement('div');
  card.className = 'gmc-card';

  // Single meeting cost (always shown)
  const singleRow = document.createElement('div');
  singleRow.className = 'gmc-row gmc-row--primary';
  singleRow.innerHTML = `
    <span class="gmc-label">This meeting</span>
    <span class="gmc-value">${formatCurrency(singleCost)}</span>
  `;
  card.appendChild(singleRow);

  if (isRecurring) {
    const monthRow = document.createElement('div');
    monthRow.className = 'gmc-row';
    monthRow.innerHTML = `
      <span class="gmc-label">Monthly cost</span>
      <span class="gmc-value">${formatCurrency(monthlyCost)}</span>
    `;
    card.appendChild(monthRow);

    const yearRow = document.createElement('div');
    yearRow.className = 'gmc-row';
    yearRow.innerHTML = `
      <span class="gmc-label">Yearly cost</span>
      <span class="gmc-value gmc-value--accent">${formatCurrency(yearlyCost)}</span>
    `;
    card.appendChild(yearRow);
  }

  section.appendChild(card);

  // Assumptions / meta info
  const meta = document.createElement('div');
  meta.className = 'gmc-meta';
  meta.textContent = `${attendees} attendee${attendees !== 1 ? 's' : ''} · ${formatHours(durationHours)} · ${formatCurrency(rate)}/person/hr`;
  section.appendChild(meta);

  if (isRecurring && recurrenceText) {
    const recMeta = document.createElement('div');
    recMeta.className = 'gmc-meta gmc-recurrence';
    const occDisplay = occurrencesPerMonth >= 1
      ? `~${Math.round(occurrencesPerMonth)}×/month`
      : `~${(occurrencesPerMonth * 12).toFixed(1)}×/year`;
    recMeta.textContent = `${recurrenceText} (${occDisplay})`;
    section.appendChild(recMeta);
  }

  // Settings link
  const settingsLink = document.createElement('div');
  settingsLink.className = 'gmc-settings-link';
  settingsLink.innerHTML = `<a href="#" class="gmc-settings-anchor">Change rate</a>`;
  settingsLink.querySelector('a').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'openOptions' });
  });
  section.appendChild(settingsLink);

  return section;
}

async function processPopup(dialogEl) {
  if (!dialogEl || dialogEl.getAttribute(INJECTION_MARKER)) return;
  dialogEl.setAttribute(INJECTION_MARKER, 'true');

  await loadSettings();

  const attendees = extractAttendeeCount(dialogEl);
  const rawDuration = extractDuration(dialogEl);
  const durationHours = rawDuration !== null ? rawDuration : 1;
  const { isRecurring, recurrenceText, occurrencesPerMonth } = extractRecurrence(dialogEl);

  const rate = costPerPersonPerHour;
  const singleCost = attendees * durationHours * rate;
  const monthlyCost = isRecurring ? singleCost * occurrencesPerMonth : 0;
  const yearlyCost = monthlyCost * 12;

  const section = buildCostSection({
    attendees,
    durationHours,
    isRecurring,
    recurrenceText,
    occurrencesPerMonth,
    singleCost,
    monthlyCost,
    yearlyCost,
    rate,
  });

  // Append at the bottom of the dialog content area
  // Try to find a sensible insertion point
  const contentArea =
    dialogEl.querySelector('[data-view-type]') ||
    dialogEl.querySelector('[role="main"]') ||
    dialogEl.querySelector('c-wiz') ||
    dialogEl;

  contentArea.appendChild(section);
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

function findDialogs(root) {
  const found = [];

  // Direct match
  if (root.matches && root.matches('[role="dialog"]')) {
    found.push(root);
  }

  // Nested matches
  if (root.querySelectorAll) {
    root.querySelectorAll('[role="dialog"]').forEach((el) => found.push(el));
  }

  return found;
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const dialogs = findDialogs(node);
      for (const dialog of dialogs) {
        // Small delay to let Google Calendar finish rendering the dialog content
        setTimeout(() => processPopup(dialog), 300);
      }
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Handle any dialogs already present on load (e.g. direct URL with event open)
document.querySelectorAll('[role="dialog"]').forEach((el) => {
  setTimeout(() => processPopup(el), 300);
});
