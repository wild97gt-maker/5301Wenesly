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

## Sharing with your household

The tracker can be shared through a link: anyone who opens it, on a phone or computer,
sees the same tracker and can update it. There's no sign-in, and changes show up live
for everyone who has it open. The site is hosted on GitHub Pages and the data is kept
in a free Firebase Realtime Database that you own.

### One-time setup (about 10 minutes)

1. **Create the database**
   1. Go to <https://console.firebase.google.com> and create a project (Google
      Analytics isn't needed).
   2. In the project, open **Build → Realtime Database** and click **Create Database**.
      Pick a location near you and choose **Start in locked mode**.
   3. Open the **Rules** tab, replace everything there with the contents of
      [`database.rules.json`](database.rules.json), and click **Publish**.
   4. On the **Data** tab, copy the database URL. It looks like
      `https://your-project-default-rtdb.firebaseio.com`.
2. **Connect the app to it**: paste the URL into [`js/config.js`](js/config.js) as
   `firebaseUrl` and commit the change. On GitHub you can do this in the browser: open
   the file, click the pencil icon, edit, then **Commit changes**.
3. **Put the site online**: in this repository on GitHub, go to **Settings → Pages**.
   Under **Build and deployment**, choose **Deploy from a branch**, select the
   `claude/house-maintenance-tracker-rk7rmp` branch and the `/ (root)` folder, and
   **Save**. After a minute or two, the address appears at the top of that page
   (for this repository it should be <https://wild97gt-maker.github.io/5301Wenesly/>).
4. Open the site, click **Share**, then **Create share link**, and send the link to
   your partner. The new shared tracker starts with whatever was in your browser.

Each device remembers the tracker once the link has been opened, so the plain site
address works afterwards too. Adding the page to your phone's home screen makes it
feel like an app.

### Who can see and change it

- Anyone with the share link can view and edit the tracker, with no sign-in.
- The link ends in a random 22-character code (`#k=…`). Without it the tracker can't be
  found or opened, so treat the link like a password. The code comes after the `#`,
  so it's never sent to GitHub.
- The database URL in `js/config.js` is public, but on its own it gives no access to
  your tracker.
- Firebase may warn you that your rules allow public access. That's expected here:
  the share link is the key.
- To remove the tracker from one device, open **Share link** and choose
  **Stop using this tracker on this device**. The shared tracker itself stays online.

### Without sharing

If `firebaseUrl` in `js/config.js` is empty, there's no Share button and each browser
keeps its own data in `localStorage`. Open `index.html` directly, or serve the folder:

```sh
npm start        # python3 -m http.server 8000, then visit http://localhost:8000
```

### Backups and moving data

**Export backup** in the footer saves everything as a JSON file, and **Import backup**
replaces the tracker's contents with a saved file. To move data from another copy of
the tracker, export it there and import it into the shared tracker.

## Tests

```sh
npm test
```

Covers the scheduling logic in `js/logic.js` (next-due calculation, end-of-month
handling, status classification, sorting) and both storage backends in `js/store.js`.
The Firebase backend is tested against stand-ins for `fetch` and `EventSource` that
follow the Realtime Database REST streaming protocol.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and dialogs |
| `styles.css` | Styling (light/dark, mobile layout) |
| `js/config.js` | Sharing settings (your Firebase database URL) |
| `js/logic.js` | Pure date & scheduling helpers |
| `js/store.js` | Storage: this browser's localStorage, or a shared Firebase household |
| `js/app.js` | UI, rendering, sharing, import/export |
| `database.rules.json` | Firebase rules: a household is readable and writable only with its key |
