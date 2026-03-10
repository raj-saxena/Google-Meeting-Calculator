# Google Meeting Cost Calculator – Firefox Extension

A Firefox extension that analyses Google Calendar event detail popups and shows the **real monetary cost** of each meeting, calculated from the number of participants, meeting duration, and a configurable hourly rate per person.

---

## Features

| Feature | Description |
|---|---|
| **Per-meeting cost** | Participants × duration × hourly rate |
| **Recurring events** | Monthly and yearly cost projections for daily / weekly / bi-weekly / monthly recurring events |
| **Configurable rate** | Set your own cost-per-person-per-hour via the toolbar popup or the full settings page |
| **Multiple currencies** | USD, EUR, GBP, JPY, CAD, AUD, INR, CHF, BRL, MXN |
| **Live preview** | Settings page shows a live cost preview as you type |

---

## How It Works

1. The extension injects a content script on `https://calendar.google.com/*`.
2. A `MutationObserver` watches for `role="dialog"` elements (Google Calendar event detail popups).
3. When a popup opens the script:
   - **Counts attendees** – tries several DOM strategies (data attributes, "X guests" text, avatar images, list items).
   - **Parses duration** – extracts the time range from the popup text (e.g. `9:00 AM – 10:30 AM`).
   - **Detects recurrence** – matches phrases like "Every Monday", "Daily", "Every month", etc.
   - **Calculates cost** – `attendees × duration_h × cost_per_person_per_hour`.
4. A styled cost section is injected into the popup showing:
   - Participants, duration, and rate summary
   - **Cost per meeting**
   - **Monthly cost** and **Yearly cost** (recurring events only)

---

## Installation (Developer Mode)

1. Open Firefox and go to `about:debugging`.
2. Click **This Firefox** → **Load Temporary Add-on…**
3. Select the `manifest.json` file from this directory.
4. Navigate to [Google Calendar](https://calendar.google.com) and click any event.

---

## Configuration

Click the **$** toolbar icon to open the quick-settings popup where you can set the cost per person per hour.

For more options (currency selection, live preview) click **More settings** or go to the extension's options page via `about:addons`.

---

## File Structure

```
├── manifest.json      Firefox extension manifest (MV2)
├── content.js         Content script – detects popups, calculates & injects costs
├── content.css        Styles for the injected cost section
├── popup.html         Toolbar popup UI
├── popup.js           Toolbar popup logic
├── options.html       Full settings/options page
├── options.js         Options page logic
└── icons/
    └── icon.svg       Extension icon
```

---

## License

MIT – see [LICENSE](LICENSE).
