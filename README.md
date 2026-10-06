# House Maintenance Tracker

A simple web app for keeping a house in shape:

- **Maintenance** – recurring tasks (HVAC filters, gutters, smoke detectors…) showing
  how often each needs doing, when it was last serviced, and when it's due next.
  Tasks are sorted by urgency and flagged as **Overdue**, **Due soon** (within 14 days),
  **Not yet serviced**, or **Up to date**. "Mark done" logs a service entry (date, cost,
  who did it, notes) and moves the next due date forward.
- **Projects** – one-off home projects with status, priority, target date, budget vs.
  actual cost, and an assigned vendor.
- **Vendors** – your preferred contractors with trade, contact info, website, rating and
  notes. Vendors can be linked to tasks and projects, and phone numbers are tap-to-call.

## Running it

No build step or dependencies. Either open `index.html` directly in a browser, or serve
the folder:

```sh
npm start        # python3 -m http.server 8000, then visit http://localhost:8000
```

It also works as-is on GitHub Pages (Settings → Pages → deploy from this branch).

## Your data

Everything is stored in your browser's `localStorage` — nothing is sent anywhere. Data
doesn't sync between browsers or devices, so use **Export backup** in the footer
to save a JSON file and **Import backup** to restore it (or move it to another device).

## Tests

```sh
npm test
```

Covers the scheduling logic in `js/logic.js` (next-due calculation, end-of-month
handling, status classification, sorting).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and the add/edit dialogs |
| `styles.css` | Styling (light/dark mode, mobile layout) |
| `js/logic.js` | Pure date & scheduling helpers |
| `js/app.js` | UI, storage, import/export |
