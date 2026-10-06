// Where the tracker keeps its data. Two backends share one interface:
//
//   local    - this browser's localStorage. Only this browser sees it.
//   firebase - a "household" in a Firebase Realtime Database. Everyone with
//              the household's share link can open and edit it on any device,
//              with no sign-in, and changes arrive live.
//
// Interface:
//   store.mode                         "local" | "firebase"
//   store.subscribe(onChange, onStatus) onChange(state, { exists }) once data
//                                       has loaded and after every change;
//                                       onStatus("live" | "offline" | "denied")
//   store.put(kind, item)              create or replace one record
//   store.remove(kind, id)
//   store.replaceAll(state)            used by "Import backup"
//   store.reconnect()                  retry right away (e.g. tab came back)
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
  // imported file or from another person's device, so it is cleaned on the
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

  // Ids double as database keys, which allow only these characters.
  function isValidId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);
  }

  // A household key is the secret part of a share link.
  function isHouseholdKey(key) {
    return typeof key === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(key);
  }

  // 16 random bytes (128 bits), written in URL-safe base64: 22 characters.
  function newHouseholdKey(getRandomValues = (a) => crypto.getRandomValues(a)) {
    const bytes = getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
        // Firebase can hand back a list as an object keyed "0", "1", ...
        const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
        out[key] = list.filter((h) => h && typeof h === "object").map(cleanHistory);
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
          const id = isValidId(item.id) && !seen.has(item.id) ? item.id : uid();
          seen.add(id);
          return cleanItem(kind, item, id);
        });
    }
    return s;
  }

  // Firebase rejects keys containing . $ # [ ] / or control characters.
  function firebaseSafe(value) {
    if (Array.isArray(value)) return value.map(firebaseSafe);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k && !/[.$#[\]/\u0000-\u001f\u007f]/.test(k)) out[k] = firebaseSafe(v);
    }
    return out;
  }

  // A stored record holds everything except its id, which is its key.
  function toDoc(item) {
    const { id, ...body } = item;
    return firebaseSafe(JSON.parse(JSON.stringify(body)));
  }

  // { tasks: [...], ... } -> { tasks: { id: body }, ... }
  function toMaps(state) {
    const out = {};
    for (const kind of KINDS) out[kind] = Object.fromEntries(state[kind].map((x) => [x.id, toDoc(x)]));
    return out;
  }

  // { tasks: { id: body }, ... } -> { tasks: [...], ... }
  function fromTree(tree) {
    const s = emptyState();
    if (!tree || typeof tree !== "object") return s;
    for (const kind of KINDS) {
      const coll = tree[kind];
      if (!coll || typeof coll !== "object") continue;
      s[kind] = Object.keys(coll)
        .filter((id) => isValidId(id) && coll[id] && typeof coll[id] === "object")
        .map((id) => cleanItem(kind, coll[id], id));
    }
    return s;
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
      listeners.forEach((fn) => fn(current, { exists: true }));
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

    return {
      mode: "local",
      subscribe(onChange, onStatus) {
        listeners.add(onChange);
        onChange(current, { exists: true });
        if (onStatus) onStatus("live");
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
      reconnect() {},
    };
  }

  // ---------- Firebase (shared household, no sign-in) ----------
  //
  // Uses the Realtime Database REST API: reads and writes are plain HTTPS
  // requests, and live updates come from its server-sent event stream, so no
  // Firebase SDK is needed. Data lives at /households/<key>:
  //   { meta: {...}, tasks: { <id>: {...} }, projects: {...}, vendors: {...} }

  function trimSlash(url) {
    return String(url).replace(/\/+$/, "");
  }

  function householdUrl(baseUrl, key, path = "", query = "") {
    return `${trimSlash(baseUrl)}/households/${key}${path ? "/" + path : ""}.json${query}`;
  }

  // Turns an HTTP failure into an error with a code the page can explain.
  async function send(fetchImpl, url, method, body) {
    let res;
    try {
      res = await fetchImpl(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw { code: "offline", message: "You seem to be offline, so that change wasn't saved. Check your connection and try again." };
    }
    if (res.status === 401 || res.status === 403) {
      throw { code: "denied", message: "The database refused the change. Check that its rules match database.rules.json." };
    }
    if (!res.ok) throw { code: "unavailable", message: `The database couldn't save that change (error ${res.status}). Try again.` };
    return res;
  }

  async function createHousehold({ baseUrl, data, fetchImpl = fetch, getRandomValues } = {}) {
    const key = newHouseholdKey(getRandomValues);
    const body = { meta: { createdAt: new Date().toISOString() }, ...toMaps(normalize(data)) };
    await send(fetchImpl, householdUrl(baseUrl, key, "", "?print=silent"), "PUT", body);
    return key;
  }

  function createFirebaseStore({
    baseUrl,
    key,
    fetchImpl = (...args) => fetch(...args),
    EventSourceImpl = typeof EventSource !== "undefined" ? EventSource : undefined,
    retryMs = 5000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  }) {
    if (!isHouseholdKey(key)) throw new TypeError("Not a household key");
    let tree; // undefined until loaded; null when the household doesn't exist
    let started = false;
    let status = null;
    let source = null;
    let retryTimer = null;
    let failures = 0;
    const listeners = new Set();
    const statusListeners = new Set();

    function setStatus(next) {
      if (next === status) return;
      status = next;
      statusListeners.forEach((fn) => fn(next));
    }

    function emit() {
      if (tree === undefined) return;
      const state = fromTree(tree);
      const info = { exists: tree !== null };
      listeners.forEach((fn) => fn(state, info));
    }

    function parts(path) {
      return String(path).split("/").filter(Boolean);
    }

    function getAt(path) {
      let node = tree;
      for (const p of parts(path)) {
        if (!node || typeof node !== "object") return null;
        node = node[p];
      }
      return node === undefined ? null : JSON.parse(JSON.stringify(node));
    }

    // Set the value at a slash path in the local copy; null deletes it.
    function setAt(path, value) {
      const keys = parts(path);
      if (!keys.length) {
        tree = value === undefined ? null : value;
        return;
      }
      if (!tree || typeof tree !== "object") tree = {};
      let node = tree;
      for (const k of keys.slice(0, -1)) {
        if (!node[k] || typeof node[k] !== "object") node[k] = {};
        node = node[k];
      }
      const last = keys[keys.length - 1];
      if (value === null || value === undefined) delete node[last];
      else node[last] = value;
    }

    function onEvent(e, isPatch) {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (!msg || typeof msg.path !== "string") return;
      if (isPatch) {
        if (msg.data && typeof msg.data === "object") {
          for (const [k, v] of Object.entries(msg.data)) setAt(`${msg.path}/${k}`, v);
        }
      } else {
        setAt(msg.path, msg.data);
      }
      failures = 0;
      setStatus("live");
      emit();
    }

    // Fetch the whole household once. Used before the stream is up, after
    // the stream drops, and to recover from a failed write.
    async function refresh() {
      try {
        const res = await fetchImpl(householdUrl(baseUrl, key));
        if (res.status === 401 || res.status === 403) {
          setStatus("denied");
          return;
        }
        if (!res.ok) return;
        tree = await res.json();
        emit();
      } catch (err) {
        /* offline: keep what we have */
      }
    }

    function scheduleRetry() {
      if (source) source.close();
      source = null;
      failures += 1;
      if (status !== "denied") setStatus("offline");
      refresh();
      clearTimer(retryTimer);
      retryTimer = setTimer(connect, Math.min(retryMs * 2 ** (failures - 1), 60000));
    }

    function connect() {
      clearTimer(retryTimer);
      if (source) source.close();
      try {
        source = new EventSourceImpl(householdUrl(baseUrl, key));
      } catch (err) {
        source = null;
        scheduleRetry();
        return;
      }
      const current = source;
      current.addEventListener("put", (e) => current === source && onEvent(e, false));
      current.addEventListener("patch", (e) => current === source && onEvent(e, true));
      // The database's rules stopped allowing reads here.
      current.addEventListener("cancel", () => {
        if (current !== source) return;
        setStatus("denied");
        scheduleRetry();
      });
      current.onerror = () => {
        if (current !== source) return;
        // CLOSED (2) means the browser gave up; otherwise it is already
        // reconnecting by itself.
        if (current.readyState === 2) scheduleRetry();
        else if (tree !== undefined) setStatus("offline");
      };
    }

    // Show a change immediately; the live stream then confirms it. If the
    // database refuses it, put back what was there before.
    async function write(method, path, body) {
      const before = getAt(path);
      setAt(path, method === "DELETE" ? null : body);
      emit();
      const url = householdUrl(baseUrl, key, path, "?print=silent");
      try {
        try {
          await send(fetchImpl, url, method, body);
        } catch (err) {
          if (err.code !== "unavailable") throw err;
          await new Promise((resolve) => setTimer(resolve, 500 + Math.random() * 500));
          await send(fetchImpl, url, method, body);
        }
      } catch (err) {
        setAt(path, before);
        emit();
        refresh();
        throw err;
      }
    }

    return {
      mode: "firebase",
      key,
      subscribe(onChange, onStatus) {
        listeners.add(onChange);
        if (onStatus) statusListeners.add(onStatus);
        if (tree !== undefined) onChange(fromTree(tree), { exists: tree !== null });
        if (!started) {
          started = true;
          connect();
        }
      },
      put(kind, item) {
        return write("PUT", `${kind}/${item.id}`, toDoc(cleanItem(kind, item, item.id)));
      },
      remove(kind, id) {
        return write("DELETE", `${kind}/${id}`);
      },
      replaceAll(next) {
        const meta = (tree && tree.meta) || { createdAt: new Date().toISOString() };
        return write("PUT", "", { meta, ...toMaps(normalize(next)) });
      },
      reconnect() {
        if (status !== "live") {
          failures = 0;
          connect();
        }
      },
      close() {
        clearTimer(retryTimer);
        if (source) source.close();
        source = null;
      },
    };
  }

  return {
    KINDS,
    STORAGE_KEY,
    uid,
    isValidId,
    isHouseholdKey,
    newHouseholdKey,
    emptyState,
    normalize,
    cleanItem,
    toDoc,
    firebaseSafe,
    createLocalStore,
    createHousehold,
    createFirebaseStore,
  };
});
