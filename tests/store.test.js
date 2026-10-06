const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/store.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const KEY = "AbCdEfGhIjKlMnOpQrStUv"; // 22 chars, like a real household key
const BASE = "https://example-default-rtdb.firebaseio.com/";
const ROOT = `https://example-default-rtdb.firebaseio.com/households/${KEY}`;

// In-memory stand-in for localStorage.
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    failWrites: false,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (this.failWrites) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
  };
}

// Stand-in for the browser's EventSource, driven by the test.
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  // Deliver a Firebase streaming event ("put", "patch", "cancel", ...).
  send(type, payload) {
    this.readyState = 1;
    (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(payload) }));
  }
  // closed=true: the browser gave up; false: it is reconnecting by itself.
  fail(closed) {
    this.readyState = closed ? 2 : 0;
    if (this.onerror) this.onerror({});
  }
  close() {
    this.readyState = 2;
    this.closed = true;
  }
}
FakeEventSource.instances = [];

// Stand-in for fetch: records each request and answers with handler().
function fakeFetch(handler = () => ({ status: 204 })) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const call = { url, method: opts.method || "GET", body: opts.body === undefined ? undefined : JSON.parse(opts.body) };
    calls.push(call);
    const r = await handler(call);
    if (r === "network-error") throw new TypeError("Failed to fetch");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? null : r.body) };
  };
  fn.calls = calls;
  return fn;
}

// A Firebase store wired to fakes, with timers the test can run by hand.
function firebaseStore(fetchImpl = fakeFetch()) {
  FakeEventSource.instances = [];
  const timers = [];
  const store = S.createFirebaseStore({
    baseUrl: BASE,
    key: KEY,
    fetchImpl,
    EventSourceImpl: FakeEventSource,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  const updates = [];
  const statuses = [];
  store.subscribe((state, info) => updates.push({ state, info }), (s) => statuses.push(s));
  const es = () => FakeEventSource.instances.at(-1);
  const latest = () => updates.at(-1).state;
  const runTimers = async () => {
    const due = timers.splice(0);
    for (const t of due) await t.fn();
  };
  return { store, updates, statuses, es, latest, timers, runTimers, fetchImpl };
}

const HOUSEHOLD = {
  meta: { createdAt: "2026-10-06T00:00:00Z" },
  tasks: { t1: { name: "Replace HVAC filter", frequency: 3, frequencyUnit: "months", lastServiced: "2026-09-01" } },
  vendors: { v1: { name: "Ace Heating", trade: "HVAC" } },
};

// ---------- normalize & helpers ----------

test("normalize cleans records from untrusted input", () => {
  const s = S.normalize({
    tasks: [
      { id: "ok1", name: "Filter", frequency: "3", frequencyUnit: "months", history: [{ date: "2026-01-01", cost: 5 }, "junk"] },
      { id: "ok1", name: "Duplicate id" },
      { id: "has space", name: 42, frequency: -2, frequencyUnit: "fortnights" },
      null,
      "junk",
    ],
    vendors: [{ name: "Ace", rating: 5 }],
    projects: "not a list",
    extra: [{ id: "x" }],
  });
  assert.equal(s.tasks.length, 3);
  assert.equal(s.tasks[0].id, "ok1");
  assert.equal(s.tasks[0].frequency, 3);
  assert.deepEqual(s.tasks[0].history, [{ date: "2026-01-01", cost: "5", vendorId: "", notes: "", by: "" }]);
  assert.notEqual(s.tasks[1].id, "ok1", "duplicate id gets a fresh one");
  assert.ok(S.isValidId(s.tasks[2].id), "invalid id gets a fresh one");
  assert.equal(s.tasks[2].name, "42");
  assert.equal(s.tasks[2].frequency, 1);
  assert.equal(s.tasks[2].frequencyUnit, "months");
  assert.equal(s.vendors[0].rating, "5");
  assert.ok(S.isValidId(s.vendors[0].id));
  assert.deepEqual(s.projects, []);
  assert.equal("extra" in s, false);
});

test("cleanItem keeps unknown fields, fills defaults, and reads list-shaped objects", () => {
  const t = S.cleanItem("tasks", { name: "", future: "kept", history: { 0: { date: "2026-02-01" } } }, "t1");
  assert.equal(t.id, "t1");
  assert.equal(t.name, "Untitled");
  assert.equal(t.future, "kept");
  assert.equal(t.history.length, 1);
  assert.equal(t.history[0].date, "2026-02-01");
});

test("toDoc drops the id, undefined values and keys Firebase rejects", () => {
  assert.deepEqual(S.toDoc({ id: "a", name: "x", gone: undefined, "bad.key": 1, nested: { "a/b": 2, ok: 3 } }), {
    name: "x",
    nested: { ok: 3 },
  });
});

test("household keys are long, random and URL-safe", () => {
  const a = S.newHouseholdKey();
  const b = S.newHouseholdKey();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
  assert.ok(S.isHouseholdKey(a));
  assert.equal(S.isHouseholdKey("short"), false);
  assert.equal(S.isHouseholdKey("has/slash/and-is-long-enough"), false);
  assert.throws(() => S.createFirebaseStore({ baseUrl: BASE, key: "short" }), TypeError);
});

// ---------- local store ----------

test("local store seeds starter tasks on first visit and persists them", () => {
  const storage = memoryStorage();
  const store = S.createLocalStore({ storage, starter: () => [{ id: "s1", name: "Starter" }] });
  let seen;
  store.subscribe((s) => (seen = s));
  assert.equal(store.mode, "local");
  assert.equal(seen.tasks[0].name, "Starter");
  assert.equal(JSON.parse(storage.map.get(S.STORAGE_KEY)).tasks[0].id, "s1");

  // A second visit reads saved data instead of seeding again.
  const again = S.createLocalStore({ storage, starter: () => [{ id: "s2", name: "Other" }] });
  again.subscribe((s) => (seen = s));
  assert.deepEqual(seen.tasks.map((t) => t.id), ["s1"]);
});

test("local store put, remove and replaceAll", async () => {
  const storage = memoryStorage({ [S.STORAGE_KEY]: JSON.stringify({ tasks: [], projects: [], vendors: [] }) });
  const store = S.createLocalStore({ storage });
  let seen;
  store.subscribe((s) => (seen = s));

  await store.put("vendors", { id: "v1", name: "Ace" });
  await store.put("vendors", { id: "v1", name: "Ace Heating" });
  assert.deepEqual(seen.vendors.map((v) => v.name), ["Ace Heating"]);

  await store.remove("vendors", "v1");
  assert.equal(seen.vendors.length, 0);

  await store.replaceAll({ tasks: [{ id: "t9", name: "Imported" }] });
  assert.deepEqual(seen.tasks.map((t) => t.id), ["t9"]);
  assert.equal(JSON.parse(storage.map.get(S.STORAGE_KEY)).tasks[0].name, "Imported");
});

test("local store reports a failed save but keeps the change on screen", async () => {
  const storage = memoryStorage({ [S.STORAGE_KEY]: "{}" });
  const store = S.createLocalStore({ storage });
  let seen;
  store.subscribe((s) => (seen = s));
  storage.failWrites = true;
  await assert.rejects(store.put("tasks", { id: "t1", name: "Filter" }), /couldn't save/);
  assert.equal(seen.tasks[0].name, "Filter");
});

test("local store survives corrupted saved data", () => {
  const store = S.createLocalStore({ storage: memoryStorage({ [S.STORAGE_KEY]: "{not json" }) });
  let seen;
  store.subscribe((s) => (seen = s));
  assert.deepEqual(seen, S.emptyState());
});

test("local store follows changes made in another tab", () => {
  const handlers = {};
  const win = { addEventListener: (type, fn) => (handlers[type] = fn) };
  const store = S.createLocalStore({ storage: memoryStorage({ [S.STORAGE_KEY]: "{}" }), win });
  let seen;
  store.subscribe((s) => (seen = s));
  handlers.storage({ key: S.STORAGE_KEY, newValue: JSON.stringify({ tasks: [{ id: "t1", name: "From tab 2" }] }) });
  assert.equal(seen.tasks[0].name, "From tab 2");
  handlers.storage({ key: "something-else", newValue: "{}" });
  assert.equal(seen.tasks.length, 1);
});

// ---------- Firebase store: reading ----------

test("firebase store streams the household and applies put and patch events", () => {
  const f = firebaseStore();
  assert.equal(f.es().url, `${ROOT}.json`);
  assert.equal(f.updates.length, 0, "nothing shown before data arrives");

  f.es().send("put", { path: "/", data: HOUSEHOLD });
  assert.equal(f.updates.at(-1).info.exists, true);
  assert.deepEqual(f.statuses, ["live"]);
  assert.equal(f.latest().tasks[0].id, "t1");
  assert.equal(f.latest().vendors[0].name, "Ace Heating");

  // Someone else adds a project, then edits and removes things.
  f.es().send("put", { path: "/projects/p1", data: { name: "Repaint deck", status: "Planned" } });
  assert.equal(f.latest().projects[0].name, "Repaint deck");
  f.es().send("patch", { path: "/tasks/t1", data: { lastServiced: "2026-10-01", notes: "16x25x1" } });
  assert.equal(f.latest().tasks[0].lastServiced, "2026-10-01");
  assert.equal(f.latest().tasks[0].name, "Replace HVAC filter", "patch keeps other fields");
  f.es().send("put", { path: "/vendors/v1", data: null });
  assert.equal(f.latest().vendors.length, 0);
  f.es().send("keep-alive", null);
  f.es().send("put", { path: "/tasks/bad id!", data: { name: "skipped" } });
  assert.equal(f.latest().tasks.length, 1, "records with unusable ids are ignored");
});

test("firebase store reports a household that doesn't exist", () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: null });
  assert.equal(f.updates.at(-1).info.exists, false);
  assert.deepEqual(f.latest(), S.emptyState());
});

test("firebase store ignores malformed stream messages", () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  const count = f.updates.length;
  f.es().listeners.put[0]({ data: "{not json" });
  f.es().listeners.put[0]({ data: JSON.stringify({ data: 1 }) });
  assert.equal(f.updates.length, count);
});

// ---------- Firebase store: writing ----------

test("put shows the change at once and writes the record at its own path", async () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  const pending = f.store.put("tasks", { id: "t9", name: "Clean gutters", frequency: 6, frequencyUnit: "months", history: [] });
  assert.ok(f.latest().tasks.some((t) => t.id === "t9"), "visible before the server answers");
  await pending;
  const call = f.fetchImpl.calls.at(-1);
  assert.equal(call.method, "PUT");
  assert.equal(call.url, `${ROOT}/tasks/t9.json?print=silent`);
  assert.equal("id" in call.body, false);
  assert.equal(call.body.name, "Clean gutters");
});

test("remove deletes the record's path", async () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  await f.store.remove("vendors", "v1");
  assert.deepEqual(f.fetchImpl.calls.at(-1), { url: `${ROOT}/vendors/v1.json?print=silent`, method: "DELETE", body: undefined });
  assert.equal(f.latest().vendors.length, 0);
});

test("replaceAll writes the whole household and keeps its meta", async () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  await f.store.replaceAll({ tasks: [{ id: "n1", name: "Imported" }], vendors: [] });
  const call = f.fetchImpl.calls.at(-1);
  assert.equal(call.url, `${ROOT}.json?print=silent`);
  assert.deepEqual(call.body.meta, HOUSEHOLD.meta);
  assert.deepEqual(Object.keys(call.body.tasks), ["n1"]);
  assert.deepEqual(f.latest().tasks.map((t) => t.name), ["Imported"]);
  assert.equal(f.latest().vendors.length, 0);
});

test("a refused write is undone on screen and explained", async () => {
  const f = firebaseStore(fakeFetch((call) => (call.method === "GET" ? { status: 200, body: HOUSEHOLD } : { status: 401 })));
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  const pending = f.store.put("tasks", { id: "t1", name: "Renamed" });
  assert.equal(f.latest().tasks[0].name, "Renamed");
  await assert.rejects(pending, (e) => e.code === "denied" && /rules/.test(e.message));
  assert.equal(f.latest().tasks[0].name, "Replace HVAC filter");
});

test("an offline write is undone on screen", async () => {
  const f = firebaseStore(fakeFetch(() => "network-error"));
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  await assert.rejects(f.store.remove("tasks", "t1"), (e) => e.code === "offline");
  assert.equal(f.latest().tasks.length, 1);
});

test("a server error is retried once", async () => {
  let puts = 0;
  const flaky = firebaseStore(fakeFetch((call) => (call.method === "PUT" && ++puts === 1 ? { status: 503 } : { status: 204 })));
  flaky.es().send("put", { path: "/", data: HOUSEHOLD });
  const pending = flaky.store.put("vendors", { id: "v2", name: "Bob's Plumbing" });
  await tick();
  await flaky.runTimers(); // the pause before retrying
  await pending;
  assert.equal(puts, 2);

  const down = firebaseStore(fakeFetch((call) => (call.method === "PUT" ? { status: 500 } : { status: 200, body: HOUSEHOLD })));
  down.es().send("put", { path: "/", data: HOUSEHOLD });
  const failing = down.store.put("vendors", { id: "v3", name: "Never saved" });
  await tick();
  await down.runTimers();
  await assert.rejects(failing, (e) => e.code === "unavailable");
  assert.equal(down.latest().vendors.some((v) => v.id === "v3"), false);
});

// ---------- Firebase store: connection problems ----------

test("a dropped connection shows offline, refreshes, and reconnects", async () => {
  const f = firebaseStore(fakeFetch(() => ({ status: 200, body: { ...HOUSEHOLD, projects: { p1: { name: "From refresh" } } } })));
  const first = f.es();
  first.send("put", { path: "/", data: HOUSEHOLD });

  // The browser is reconnecting on its own: just show offline.
  first.fail(false);
  assert.deepEqual(f.statuses, ["live", "offline"]);
  assert.equal(FakeEventSource.instances.length, 1);

  // The browser gave up: fetch the latest data and try again later.
  first.fail(true);
  await tick();
  assert.ok(first.closed);
  assert.equal(f.fetchImpl.calls.at(-1).url, `${ROOT}.json`);
  assert.equal(f.latest().projects[0].name, "From refresh");
  assert.equal(f.timers[0].ms, 5000);

  await f.runTimers();
  assert.equal(FakeEventSource.instances.length, 2, "a new connection was opened");
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  assert.equal(f.statuses.at(-1), "live");
});

test("data still loads when live updates are blocked entirely", async () => {
  FakeEventSource.instances = [];
  const fetchImpl = fakeFetch(() => ({ status: 200, body: HOUSEHOLD }));
  const store = S.createFirebaseStore({
    baseUrl: BASE,
    key: KEY,
    fetchImpl,
    EventSourceImpl: function () {
      throw new Error("blocked");
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  let seen;
  store.subscribe((s) => (seen = s));
  await tick();
  assert.equal(seen.tasks[0].name, "Replace HVAC filter");
});

test("losing read access is reported as denied", async () => {
  const f = firebaseStore(fakeFetch(() => ({ status: 401 })));
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  f.es().send("cancel", "Permission denied");
  await tick();
  assert.equal(f.statuses.at(-1), "denied");
});

test("reconnect() only reconnects when not live", () => {
  const f = firebaseStore();
  f.es().send("put", { path: "/", data: HOUSEHOLD });
  f.store.reconnect();
  assert.equal(FakeEventSource.instances.length, 1);
  f.es().fail(false);
  f.store.reconnect();
  assert.equal(FakeEventSource.instances.length, 2);
});

// ---------- creating a household ----------

test("createHousehold writes the current data under a new key", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 204 }));
  const key = await S.createHousehold({
    baseUrl: BASE,
    fetchImpl,
    data: { tasks: [{ id: "t1", name: "Filter" }], projects: [], vendors: [{ id: "v1", name: "Ace" }] },
  });
  assert.ok(S.isHouseholdKey(key));
  const call = fetchImpl.calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.url, `https://example-default-rtdb.firebaseio.com/households/${key}.json?print=silent`);
  assert.ok(call.body.meta.createdAt);
  assert.equal(call.body.tasks.t1.name, "Filter");
  assert.equal(call.body.vendors.v1.name, "Ace");

  const refused = fakeFetch(() => ({ status: 401 }));
  await assert.rejects(S.createHousehold({ baseUrl: BASE, fetchImpl: refused, data: {} }), (e) => e.code === "denied");
});
