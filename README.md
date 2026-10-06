# House Maintenance Tracker

A simple web app for keeping a house in shape:

- **Maintenance**: recurring tasks (HVAC filters, gutters, smoke detectors…) showing
  how often each needs doing, when it was last serviced, and when it's due next.
  Tasks are sorted by urgency and flagged as **Overdue**, **Due soon** (within 14 days),
  **Not yet serviced**, or **Up to date**. "Mark done" logs a service entry (date, cost,
  who did it, notes) and moves the next due date forward. "History" shows past entries.
- **Projects**: one-off home projects with status, priority, target date, budget vs.
  actual cost, and an assigned vendor.
- **Vendors**: your preferred contractors with trade, contact info, website, rating and
  notes. Vendors can be linked to tasks and projects.

## Two ways to run it

The same code runs in two modes and picks one automatically.

### Shared (Claude artifact)

Published as a [Claude artifact](https://claude.ai), the tracker keeps its data in the
artifact's built-in database. Everyone the artifact is shared with sees the same data,
and changes show up live for everyone who has it open. Service entries record who
logged them.

To build the single-file page that gets published:

```sh
npm run build    # writes dist/house-maintenance.html
```

It is published with the `db`, `user` (profile scope) and `downloads` capabilities.

To share it with someone so they can also make changes:

1. Open the artifact on claude.ai and choose **Share**.
2. Invite them by email and give them edit access (**Editor**).
3. Leave the public link off. While a public link is on, people outside your
   organization can view but not edit.

They need to be signed in to Claude to open it. Anyone with view-only access sees
the tracker with editing turned off and a note explaining why.

### Local (this browser only)

Open `index.html` directly, or serve the folder (it also works as-is on GitHub Pages):

```sh
npm start        # python3 -m http.server 8000, then visit http://localhost:8000
```

In this mode data is stored in the browser's `localStorage` and nothing is sent
anywhere. It doesn't sync between browsers or devices.

### Backups and moving data

**Export backup** in the footer saves everything as a JSON file, and **Import backup**
replaces the tracker's contents with a saved file. To move data from a local copy into
the shared one, export it from the local copy and import it into the shared one.

## Tests

```sh
npm test
```

Covers the scheduling logic in `js/logic.js` (next-due calculation, end-of-month
handling, status classification, sorting) and both storage backends in `js/store.js`
(the shared backend is tested against an in-memory stand-in for the artifact database).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and the add/edit dialogs |
| `styles.css` | Styling (light/dark themes, mobile layout) |
| `js/logic.js` | Pure date & scheduling helpers |
| `js/store.js` | Storage: shared artifact database or this browser's localStorage |
| `js/app.js` | UI, rendering, import/export |
| `scripts/build-artifact.js` | Bundles everything into one page for publishing |
