const DEFAULT_RATE = 50;

const rateInput = document.getElementById('rate');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');

let statusTimer = null;

function showStatus(message = '✓ Saved') {
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('visible'), 2500);
}

// Load saved setting
chrome.storage.sync.get({ costPerPersonPerHour: DEFAULT_RATE }, (items) => {
  rateInput.value = parseFloat(items.costPerPersonPerHour).toFixed(2);
});

// Save
saveBtn.addEventListener('click', () => {
  const val = parseFloat(rateInput.value);
  if (isNaN(val) || val < 0) {
    rateInput.focus();
    return;
  }
  chrome.storage.sync.set({ costPerPersonPerHour: val }, () => showStatus('✓ Saved'));
});

// Reset
resetBtn.addEventListener('click', () => {
  rateInput.value = DEFAULT_RATE.toFixed(2);
  chrome.storage.sync.set({ costPerPersonPerHour: DEFAULT_RATE }, () => showStatus('✓ Reset to default'));
});

// Allow saving with Enter key
rateInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});
