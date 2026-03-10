/**
 * Google Meeting Cost Calculator – Content Script
 *
 * Watches for Google Calendar event detail popups, extracts:
 *   - Number of attendees
 *   - Meeting duration
 *   - Whether the event is recurring (and how often)
 *
 * Then calculates the cost of the meeting and injects a cost section
 * into the event detail popup.
 */
(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────────── */

  const COST_SECTION_ID = "gmcc-cost-section";
  const PROCESSED_ATTR = "data-gmcc-processed";
  const DEFAULT_COST_PER_PERSON_PER_HOUR = 50; // USD

  /* ── State ──────────────────────────────────────────────────────── */

  let costPerPersonPerHour = DEFAULT_COST_PER_PERSON_PER_HOUR;
  let currency = "USD";

  // Load persisted settings
  browser.storage.sync
    .get({ costPerPersonPerHour: DEFAULT_COST_PER_PERSON_PER_HOUR, currency: "USD" })
    .then((result) => {
      costPerPersonPerHour = result.costPerPersonPerHour;
      currency = result.currency;
    });

  // Keep in sync when the user changes settings in the popup/options page
  browser.storage.onChanged.addListener((changes) => {
    let changed = false;
    if (changes.costPerPersonPerHour) {
      costPerPersonPerHour = changes.costPerPersonPerHour.newValue;
      changed = true;
    }
    if (changes.currency) {
      currency = changes.currency.newValue;
      changed = true;
    }
    if (changed) refreshAllCostSections();
  });

  /* ── Duration parsing ───────────────────────────────────────────── */

  /**
   * Parse duration in hours from a text snippet that contains a time range
   * such as "9:00 AM – 10:30 AM", "14:00 – 15:00", or "9:00 – 10:30 AM".
   *
   * Returns a number (hours).  Minimum returned value is 0.25 (15 minutes).
   * Returns 1 as a safe default when no recognisable pattern is found.
   */
  function parseDuration(text) {
    if (!text) return 1;

    // Normalise en-dash / em-dash to ASCII dash and collapse whitespace
    const normalised = text.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ");

    // Full 12-hour:  "9:00 AM - 10:30 AM"
    const full12 =
      /(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;
    // Partial 12-hour (period only on end):  "9:00 - 10:30 AM"
    const partial12 = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;
    // 24-hour:  "09:00 - 10:30"
    const h24 = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;

    let sh, sm, sp, eh, em, ep;

    let m = normalised.match(full12);
    if (m) {
      [, sh, sm, sp, eh, em, ep] = m;
    } else {
      m = normalised.match(partial12);
      if (m) {
        [, sh, sm, eh, em, ep] = m;
        sp = null;
      } else {
        m = normalised.match(h24);
        if (m) {
          [, sh, sm, eh, em] = m;
          sp = null;
          ep = null;
        }
      }
    }

    if (!m) return 1;

    sh = parseInt(sh, 10);
    sm = parseInt(sm, 10);
    eh = parseInt(eh, 10);
    em = parseInt(em, 10);

    // Convert 12-hour → 24-hour
    if (sp) {
      if (sp.toUpperCase() === "PM" && sh !== 12) sh += 12;
      if (sp.toUpperCase() === "AM" && sh === 12) sh = 0;
    }
    if (ep) {
      if (ep.toUpperCase() === "PM" && eh !== 12) eh += 12;
      if (ep.toUpperCase() === "AM" && eh === 12) eh = 0;
    }

    let startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;
    if (endMin <= startMin) endMin += 24 * 60; // crosses midnight

    return Math.max((endMin - startMin) / 60, 0.25);
  }

  /* ── Attendee counting ──────────────────────────────────────────── */

  /**
   * Count the number of attendees visible in the event detail popup.
   *
   * Google Calendar does not expose structured data in the DOM, so we try
   * several heuristics in order of reliability.
   */
  function countAttendees(popup) {
    // 1. Elements that carry an explicit attendee / RSVP data attribute
    const byAttr = popup.querySelectorAll(
      "[data-attendee-id], [data-email], .attendee-email-row"
    );
    if (byAttr.length > 0) return byAttr.length;

    // 2. "X guests" text (Google Calendar collapses long lists)
    const guestMatch = (popup.innerText || "").match(/(\d+)\s+guest/i);
    if (guestMatch) {
      // The count shown is the number of *other* guests; add 1 for the organiser
      return parseInt(guestMatch[1], 10) + 1;
    }

    // 3. Avatars / profile chips – each attendee has a small circular image
    const avatars = popup.querySelectorAll(
      "img[data-iml], img[referrerpolicy], [role='img'][aria-label]"
    );
    if (avatars.length > 0) return avatars.length;

    // 4. List items inside an attendee / guest section
    const listItems = popup.querySelectorAll(
      "[aria-label*='guest' i] li, [aria-label*='attendee' i] li, " +
        "[data-attendees] li"
    );
    if (listItems.length > 0) return listItems.length;

    // Default: assume only the organiser
    return 1;
  }

  /* ── Recurrence detection ───────────────────────────────────────── */

  /**
   * Detect whether the event is recurring and, if so, estimate how many
   * times it occurs per month.
   *
   * Returns { isRecurring, type, periodsPerMonth }
   */
  function detectRecurrence(popup) {
    const text = popup.innerText || popup.textContent || "";

    // Yearly
    if (/every year|annually|once a year|yearly/i.test(text)) {
      return { isRecurring: true, type: "yearly", periodsPerMonth: 1 / 12 };
    }

    // Monthly
    if (/every month|monthly|once a month/i.test(text)) {
      return { isRecurring: true, type: "monthly", periodsPerMonth: 1 };
    }

    // Bi-weekly
    if (
      /every other week|bi.?weekly|every 2 weeks|every two weeks/i.test(text)
    ) {
      return { isRecurring: true, type: "bi-weekly", periodsPerMonth: 2.17 };
    }

    // Weekly (explicit day name or "weekly" keyword)
    if (
      /weekly|every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(
        text
      )
    ) {
      return { isRecurring: true, type: "weekly", periodsPerMonth: 4.33 };
    }

    // Daily (all days or weekdays only)
    if (
      /every day|daily|every weekday|monday to friday|mon.{0,3}fri/i.test(text)
    ) {
      // ~22 working days per month
      return { isRecurring: true, type: "daily", periodsPerMonth: 22 };
    }

    // Generic fallback – "repeat" / "recur" / "each" without a clearer pattern
    if (/repeat|recur/i.test(text)) {
      return { isRecurring: true, type: "recurring", periodsPerMonth: 4 };
    }

    return { isRecurring: false, type: null, periodsPerMonth: 0 };
  }

  /* ── Cost calculation ───────────────────────────────────────────── */

  /**
   * Calculate meeting costs.
   * Returns { single, monthly?, yearly? } – monthly/yearly only when recurring.
   */
  function calculateCosts(attendees, durationHours, recurrence) {
    const single = attendees * durationHours * costPerPersonPerHour;
    if (!recurrence.isRecurring) return { single };

    const monthly = single * recurrence.periodsPerMonth;
    const yearly = monthly * 12;
    return { single, monthly, yearly };
  }

  /* ── UI helpers ─────────────────────────────────────────────────── */

  function formatCurrency(amount) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(amount);
  }

  /**
   * Build the cost section DOM element that will be injected into the popup.
   */
  function buildCostSection(attendees, durationHours, costs, recurrence) {
    const section = document.createElement("div");
    section.id = COST_SECTION_ID;
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "Meeting cost");

    const recurringBadge = recurrence.isRecurring
      ? `<span class="gmcc-badge">Recurring · ${recurrence.type}</span>`
      : "";

    const recurringRows = recurrence.isRecurring
      ? `<div class="gmcc-row">
           <span class="gmcc-label">Monthly cost</span>
           <span class="gmcc-value">${formatCurrency(costs.monthly)}</span>
         </div>
         <div class="gmcc-row">
           <span class="gmcc-label">Yearly cost</span>
           <span class="gmcc-value gmcc-yearly">${formatCurrency(costs.yearly)}</span>
         </div>`
      : "";

    section.innerHTML = `
      <div class="gmcc-header">
        <span class="gmcc-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm.75 11.25V14a.75.75 0 01-1.5 0v-.75A2.75 2.75 0 017 10.5a.75.75 0 011.5 0 1.25 1.25 0 002.5 0c0-.69-.56-1.25-1.25-1.25h-.5a2.75 2.75 0 010-5.5V3a.75.75 0 011.5 0v.75A2.75 2.75 0 0113 6.5a.75.75 0 01-1.5 0 1.25 1.25 0 00-2.5 0c0 .69.56 1.25 1.25 1.25h.5a2.75 2.75 0 010 5.5z"/>
          </svg>
        </span>
        <span class="gmcc-title">Meeting Cost</span>
        ${recurringBadge}
      </div>
      <div class="gmcc-body">
        <div class="gmcc-meta">
          ${attendees} participant${attendees !== 1 ? "s" : ""}
          &times; ${durationHours % 1 === 0 ? durationHours : durationHours.toFixed(1)}h
          &times; ${formatCurrency(costPerPersonPerHour)}/person/h
        </div>
        <div class="gmcc-row gmcc-primary">
          <span class="gmcc-label">Cost per meeting</span>
          <span class="gmcc-value gmcc-highlight">${formatCurrency(costs.single)}</span>
        </div>
        ${recurringRows}
      </div>`;

    return section;
  }

  /* ── DOM injection ──────────────────────────────────────────────── */

  /**
   * Find the best place inside the popup to insert the cost section.
   *
   * We want to insert *before* the "More options" / "Open event" link that
   * appears at the bottom of most Google Calendar detail popups.
   */
  function findInsertionPoint(popup) {
    // "More options" link or "Open in Google Calendar" link at the footer
    const anchors = Array.from(popup.querySelectorAll("a, [role='link']"));
    for (const a of anchors) {
      const txt = (a.textContent || "").toLowerCase();
      if (txt.includes("more option") || txt.includes("open event")) {
        return { before: a.closest("div") || a };
      }
    }

    // Fallback: last button-row or action bar
    const buttons = popup.querySelectorAll('[role="toolbar"], .event-actions');
    if (buttons.length) {
      return { before: buttons[buttons.length - 1] };
    }

    // Last resort: append to popup
    return { append: popup };
  }

  function insertCostSection(popup, section) {
    const point = findInsertionPoint(popup);
    if (point.before) {
      point.before.parentNode.insertBefore(section, point.before);
    } else {
      point.append.appendChild(section);
    }
  }

  /* ── Main processing ────────────────────────────────────────────── */

  /**
   * Process an event detail popup: extract data, compute costs, inject UI.
   */
  function processPopup(popup) {
    if (popup.hasAttribute(PROCESSED_ATTR)) return;
    popup.setAttribute(PROCESSED_ATTR, "1");

    // Small delay to let Google Calendar finish rendering the popup content
    setTimeout(() => {
      try {
        if (!popup.isConnected) return;

        const text = popup.innerText || popup.textContent || "";

        // All-day events have no meaningful "per-hour" cost;
        // use 8 h as a reasonable working-day estimate.
        const isAllDay = /all.?day/i.test(text);
        const durationHours = isAllDay ? 8 : parseDuration(text);

        const attendees = countAttendees(popup);
        const recurrence = detectRecurrence(popup);
        const costs = calculateCosts(attendees, durationHours, recurrence);

        // Remove any stale section before inserting a fresh one
        popup.querySelector(`#${COST_SECTION_ID}`)?.remove();

        const section = buildCostSection(
          attendees,
          durationHours,
          costs,
          recurrence
        );
        insertCostSection(popup, section);
      } catch (err) {
        console.warn("[GMCC] Failed to process popup:", err);
      }
    }, 500);
  }

  /**
   * Re-process all currently visible popups (called when settings change).
   */
  function refreshAllCostSections() {
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((popup) => {
      popup.removeAttribute(PROCESSED_ATTR);
      popup.querySelector(`#${COST_SECTION_ID}`)?.remove();
      processPopup(popup);
    });
  }

  /* ── Popup detection ────────────────────────────────────────────── */

  function isEventDetailPopup(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    // A detail dialog always has role="dialog"
    if (el.getAttribute("role") === "dialog") return true;
    // Some views surface a chip-style popup with a data-eventid attribute
    if (el.hasAttribute("data-eventid") && el.querySelector('[role="button"]'))
      return true;
    return false;
  }

  function findAndProcessPopups(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    if (isEventDetailPopup(root)) {
      processPopup(root);
      return;
    }

    root
      .querySelectorAll('[role="dialog"], [data-eventid]')
      .forEach((el) => {
        if (isEventDetailPopup(el)) processPopup(el);
      });
  }

  /* ── MutationObserver ───────────────────────────────────────────── */

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Newly inserted nodes (popup opening)
      for (const node of mutation.addedNodes) {
        findAndProcessPopups(node);
      }

      // Attribute changes that reveal previously hidden dialogs
      if (
        mutation.type === "attributes" &&
        isEventDetailPopup(mutation.target) &&
        !mutation.target.hasAttribute(PROCESSED_ATTR)
      ) {
        processPopup(mutation.target);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "aria-hidden", "hidden"],
  });

  // Handle any popups that are already open when the script loads
  findAndProcessPopups(document.body);
})();
