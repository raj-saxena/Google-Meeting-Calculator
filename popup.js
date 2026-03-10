(function () {
  "use strict";

  const DEFAULT_COST = 50;

  const input = document.getElementById("cost-input");
  const saveBtn = document.getElementById("save-btn");
  const statusEl = document.getElementById("status");
  const optionsLink = document.getElementById("options-link");
  const currencyPrefix = document.getElementById("currency-prefix");

  // Currency symbol lookup
  const CURRENCY_SYMBOLS = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥",
    CAD: "CA$", AUD: "A$", INR: "₹", CHF: "CHF",
    BRL: "R$", MXN: "MX$",
  };

  // Load the stored values and populate the field
  browser.storage.sync
    .get({ costPerPersonPerHour: DEFAULT_COST, currency: "USD" })
    .then((result) => {
      input.value = result.costPerPersonPerHour;
      currencyPrefix.textContent = CURRENCY_SYMBOLS[result.currency] || result.currency;
    });

  function showStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? "error" : "";
    if (!isError) {
      setTimeout(() => {
        statusEl.textContent = "";
      }, 2000);
    }
  }

  function save() {
    const value = parseFloat(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      showStatus("Please enter a valid positive number.", true);
      return;
    }
    browser.storage.sync.set({ costPerPersonPerHour: value }).then(() => {
      showStatus("Saved!");
    });
  }

  saveBtn.addEventListener("click", save);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });

  optionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
  });
})();
