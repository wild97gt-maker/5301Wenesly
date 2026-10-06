// Where the tracker keeps its data. Two backends share one interface:
//
//   local  - this browser's localStorage (opening index.html directly, or any
//            normal web host). Only the person on this browser sees it.
//   shared - the Claude artifact database, used when the page is published as
//            a Claude artifact. Everyone the artifact is shared with sees the
//            same data, and changes arrive live.
//
// Interface:
//   store.mode                       "local" | "shared" | "unavailable"
//   store.subscribe(onChange, onError) calls onChange(state) once data is
//                                     loaded and again after every change
//   store.put(kind, item)            create or replace one record
//   store.remove(kind, id)
//   store.replaceAll(state)          used by "Import backup"
//   store.canWrite()                 Promise<true | false | null> (null = unknown)
//   store.me()                       Promise<user id | null>
//   store.people(ids)                Promise<{ [id]: { name, isMe } }>
//   store.canSaveFile()              Promise<boolean>: can "Export backup" work here
//   store.saveFile(filename, text)   offer a file to download
//
// Loaded as a classic script (window.HomeStore) and via require() in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HomeStore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const KINDS = ["tasks", "projects", "vendors"];
  const STORAGE_KEY = "house-maintenance-tracker:v1";
  const UNITS = ["days", "weeks", "months", "years"];

  // Every field a record can have, with its default. Data can come from an
  // imported file or from another person's browser, so it is cleaned on the
  // way in rather than trusted.
  const FIELDS = {
    tasks: {
      name: "", category: "", location: "", frequency: 1, frequencyUnit: "months",
      lastServiced: "", vendorId: "", notes: "", history: [],
    },
    projects: {
      name: "", status: "Planned", priority: "Medium", targetDate: "", budget: "",
      actualCost: "", vendorId: "", notes: "",
    },
    vendors: {
      name: "", trade: "", contact: "", phone: "", email: "", website: "", rating: "", notes: "",
    },
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Ids double as database document names, which allow only these characters.
  function isValidId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) && id !== "." && id !== "..";
  }

  function emptyState() {
    return { tasks: [], projects: [], vendors: [] };
  }

  function str(v) {
    return v === undefined || v === null ? "" : String(v);
  }

  function cleanHistory(h) {
    return { date: str(h.date), cost: str(h.cost), vendorId: str(h.vendorId), notes: str(h.notes), by: str(h.by) };
  }

  function cleanItem(kind, raw, id) {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const out = { ...src, id };
    for (const [key, def] of Object.entries(FIELDS[kind])) {
      const v = src[key];
      if (Array.isArray(def)) {
        out[key] = Array.isArray(v) ? v.filter((h) => h && typeof h === "object").map(cleanHistory) : [];
      } else if (typeof def === "number") {
        const n = Number(v);
        out[key] = Number.isFinite(n) && n > 0 ? n : def;
      } else {
        out[key] = v === undefined || v === null ? def : String(v);
      }
    }
    if (kind === "tasks" && !UNITS.includes(out.frequencyUnit)) out.frequencyUnit = "months";
    if (!out.name) out.name = "Untitled";
    return out;
  }

  function normalize(data) {
    const s = emptyState();
    if (!data || typeof data !== "object") return s;
    for (const kind of KINDS) {
      if (!Array.isArray(data[kind])) continue;
      const seen = new Set();
      s[kind] = data[kind]
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          let id = isValidId(item.id) && !seen.has(item.id) ? item.id : uid();
          seen.add(id);
          return cleanItem(kind, item, id);
        });
    }
    return s;
  }

  // Database documents hold everything except the id, which is the document name.
  function toDoc(item) {
    const { id, ...body } = item;
    return JSON.parse(JSON.stringify(body));
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------- Local (this browser only) ----------

  function createLocalStore({ storage, starter, win } = {}) {
    function read() {
      let raw = null;
      try {
        raw = storage ? storage.getItem(STORAGE_KEY) : null;
      } catch (e) {
        /* storage blocked: run in memory */
      }
      if (raw === null || raw === undefined) {
        const seeded = { ...emptyState(), tasks: starter ? starter() : [] };
        try {
          if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(seeded));
        } catch (e) {
          /* ignore: nothing to lose yet */
        }
        return seeded;
      }
      try {
        return normalize(JSON.parse(raw));
      } catch (e) {
        console.error("Could not read saved data", e);
        return emptyState();
      }
    }

    let current = read();
    const listeners = new Set();

    function notify() {
      listeners.forEach((fn) => fn(current));
    }

    function commit(next) {
      current = next;
      notify();
      try {
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(current));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(new Error("This browser couldn't save your change. Use Export backup to keep a copy."));
      }
    }

    // Keep other open tabs of the tracker in step.
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY) return;
        try {
          current = e.newValue ? normalize(JSON.parse(e.newValue)) : emptyState();
        } catch (err) {
          return;
        }
        notify();
      });
    }

    function saveFile(filename, text) {
      const doc = win.document;
      const a = doc.createElement("a");
      a.href = win.URL.createObjectURL(new win.Blob([text], { type: "application/json" }));
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => win.URL.revokeObjectURL(a.href), 1000);
      return Promise.resolve({ status: "saved" });
    }

    return {
      mode: "local",
      subscribe(onChange) {
        listeners.add(onChange);
        onChange(current);
      },
      put(kind, item) {
        const clean = cleanItem(kind, item, item.id);
        const list = current[kind];
        const exists = list.some((x) => x.id === item.id);
        const nextList = exists ? list.map((x) => (x.id === item.id ? clean : x)) : [...list, clean];
        return commit({ ...current, [kind]: nextList });
      },
      remove(kind, id) {
        return commit({ ...current, [kind]: current[kind].filter((x) => x.id !== id) });
      },
      replaceAll(next) {
        return commit(normalize(next));
      },
      canWrite: () => Promise.resolve(true),
      me: () => Promise.resolve(null),
      people: () => Promise.resolve({}),
      canSaveFile: () => Promise.resolve(Boolean(win && win.document)),
      saveFile,
    };
  }

  // ---------- Shared (Claude artifact database) ----------

  // `user` and `downloads` may be promises: the page shouldn't wait for them
  // before showing data.
  function createSharedStore({ db, user, downloads, cacheGraceMs = 5000 }) {
    const userReady = Promise.resolve(user).catch(() => null);
    const downloadsReady = Promise.resolve(downloads).catch(() => null);
    let current = emptyState();
    const loaded = new Set();
    const graceTimers = {};
    const listeners = new Set();
    const errorListeners = new Set();
    let started = false;

    // Wait until all three lists have arrived so the page never shows a
    // half-loaded tracker.
    function emit() {
      if (loaded.size === KINDS.length) listeners.forEach((fn) => fn(current));
    }

    function listen(kind, retries) {
      db.collection(kind).onSnapshot(
        (snap) => {
          current = { ...current, [kind]: snap.docs.map((d) => cleanItem(kind, d.data(), d.id)) };
          // An empty list straight from the local cache may just mean the
          // server hasn't answered yet; showing it would flash "no tasks".
          // Accept it only once confirmed, or after a grace period offline.
          const fromCache = Boolean(snap.metadata && snap.metadata.fromCache);
          if (!fromCache || snap.docs.length > 0) {
            loaded.add(kind);
          } else if (!loaded.has(kind) && !graceTimers[kind]) {
            graceTimers[kind] = setTimeout(() => {
              loaded.add(kind);
              emit();
            }, cacheGraceMs);
          }
          emit();
        },
        (err) => {
          // "unavailable" here means the connection itself died; a fresh
          // subscription is the only way back.
          if (err && err.code === "unavailable" && retries < 5) {
            setTimeout(() => listen(kind, retries + 1), 1000 * 2 ** retries);
          } else {
            errorListeners.forEach((fn) => fn(err));
          }
        }
      );
    }

    // Retry a write once after a short random pause on a transient failure.
    async function attempt(fn) {
      try {
        return await fn();
      } catch (err) {
        if (err && err.code === "unavailable") {
          await wait(300 + Math.random() * 700);
          return fn();
        }
        throw err;
      }
    }

    function put(kind, item) {
      return attempt(() => db.collection(kind).doc(item.id).set(toDoc(cleanItem(kind, item, item.id))));
    }

    function remove(kind, id) {
      return attempt(() => db.collection(kind).doc(id).delete());
    }

    return {
      mode: "shared",
      subscribe(onChange, onError) {
        listeners.add(onChange);
        if (onError) errorListeners.add(onError);
        if (loaded.size === KINDS.length) onChange(current);
        if (!started) {
          started = true;
          KINDS.forEach((kind) => listen(kind, 0));
        }
      },
      put,
      remove,
      async replaceAll(next) {
        const clean = normalize(next);
        for (const kind of KINDS) {
          const keep = new Set(clean[kind].map((x) => x.id));
          for (const old of current[kind]) if (!keep.has(old.id)) await remove(kind, old.id);
          for (const item of clean[kind]) await put(kind, item);
        }
      },
      canWrite: async () => {
        const u = await userReady;
        return u ? u.can("data.write") : null;
      },
      me: async () => {
        const u = await userReady;
        return u ? u.id() : null;
      },
      people: async (ids) => {
        const u = await userReady;
        return u && ids.length ? u.profiles(ids) : {};
      },
      canSaveFile: async () => Boolean(await downloadsReady),
      saveFile: async (filename, text) => {
        const d = await downloadsReady;
        if (!d) throw { code: "unavailable", message: "Saving files isn't available here." };
        return d.save({ filename, data: text });
      },
    };
  }

  // Inside Claude's artifact viewer `window.claude.use` exists and the shared
  // database is used. Anywhere else the tracker falls back to localStorage.
  async function open({ win, storage, starter } = {}) {
    const claude = win && win.claude;
    if (!claude || typeof claude.use !== "function") {
      return createLocalStore({ storage, starter, win });
    }
    const db = await claude.use("db");
    if (!db) return { mode: "unavailable" };
    return createSharedStore({ db, user: claude.use("user"), downloads: claude.use("downloads") });
  }

  return {
    KINDS,
    STORAGE_KEY,
    uid,
    isValidId,
    emptyState,
    normalize,
    cleanItem,
    toDoc,
    createLocalStore,
    createSharedStore,
    open,
  };
});
