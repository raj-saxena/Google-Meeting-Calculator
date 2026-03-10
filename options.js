(function () {
  "use strict";

  const DEFAULTS = {
    costPerPersonPerHour: 50,
    currency: "USD",
  };

  // Example scenario used in the live preview (5 people, 1-hour weekly meeting)
  const PREVIEW_ATTENDEES = 5;
  const PREVIEW_DURATION_H = 1;
  const PREVIEW_PERIODS_PER_MONTH = 4.33; // weekly

  /* ── DOM refs ─────────────────────────────────────────────────── */
  const costInput = document.getElementById("cost-input");
  const currencySelect = document.getElementById("currency-select");
  const currencyPrefix = document.getElementById("currency-prefix");
  const saveBtn = document.getElementById("save-btn");
  const resetBtn = document.getElementById("reset-btn");
  const statusEl = document.getElementById("status");
  const prevSingle = document.getElementById("prev-single");
  const prevMonthly = document.getElementById("prev-monthly");
  const prevYearly = document.getElementById("prev-yearly");
  const previewMeta = document.getElementById("preview-meta");

  /* ── Helpers ──────────────────────────────────────────────────── */
  const CURRENCY_SYMBOLS = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥",
    CAD: "CA$", AUD: "A$", INR: "₹", CHF: "CHF",
    BRL: "R$", MXN: "MX$",
  };

  function updateCurrencyPrefix() {
    const sym = CURRENCY_SYMBOLS[currencySelect.value] || currencySelect.value;
    currencyPrefix.textContent = sym;
  }
  function formatCurrency(amount, currency) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(amount);
  }

  function showStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? "error" : "";
    if (!isError) {
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2500);
    }
  }

  /* ── Live preview ─────────────────────────────────────────────── */
  function updatePreview() {
    const cost = parseFloat(costInput.value);
    const currency = currencySelect.value;

    if (!Number.isFinite(cost) || cost <= 0) {
      prevSingle.textContent = "—";
      prevMonthly.textContent = "—";
      prevYearly.textContent = "—";
      previewMeta.textContent = "";
      return;
    }

    const single = PREVIEW_ATTENDEES * PREVIEW_DURATION_H * cost;
    const monthly = single * PREVIEW_PERIODS_PER_MONTH;
    const yearly = monthly * 12;

    previewMeta.textContent = `${PREVIEW_ATTENDEES} people · ${PREVIEW_DURATION_H}h meeting · ${formatCurrency(cost, currency)}/person/h`;
    prevSingle.textContent = formatCurrency(single, currency);
    prevMonthly.textContent = formatCurrency(monthly, currency);
    prevYearly.textContent = formatCurrency(yearly, currency);
  }

  /* ── Load stored settings ─────────────────────────────────────── */
  browser.storage.sync.get(DEFAULTS).then((result) => {
    costInput.value = result.costPerPersonPerHour;
    currencySelect.value = result.currency;
    updateCurrencyPrefix();
    updatePreview();
  });

  /* ── Save ─────────────────────────────────────────────────────── */
  function save() {
    const cost = parseFloat(costInput.value);
    if (!Number.isFinite(cost) || cost <= 0) {
      showStatus("Please enter a valid positive number.", true);
      return;
    }
    const settings = {
      costPerPersonPerHour: cost,
      currency: currencySelect.value,
    };
    browser.storage.sync.set(settings).then(() => {
      showStatus("Settings saved!");
    });
  }

  saveBtn.addEventListener("click", save);

  costInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });

  /* ── Reset ────────────────────────────────────────────────────── */
  resetBtn.addEventListener("click", () => {
    costInput.value = DEFAULTS.costPerPersonPerHour;
    currencySelect.value = DEFAULTS.currency;
    updateCurrencyPrefix();
    updatePreview();
    browser.storage.sync.set(DEFAULTS).then(() => {
      showStatus("Reset to defaults.");
    });
  });

  /* ── Live preview on input change ─────────────────────────────── */
  costInput.addEventListener("input", updatePreview);
  currencySelect.addEventListener("change", () => {
    updateCurrencyPrefix();
    updatePreview();
  });
})();
