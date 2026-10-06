const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/store.js");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

// In-memory stand-in for the Claude artifact `db` capability: collections of
// JSON documents, onSnapshot listeners, and injectable failures.
function fakeDb({ cacheFirst = false, cacheOnly = false } = {}) {
  const data = { tasks: new Map(), projects: new Map(), vendors: new Map() };
  const subs = { tasks: [], projects: [], vendors: [] };
  const calls = [];
  const failures = [];

  function snapshot(kind) {
    const docs = [...data[kind].keys()].sort().map((id) => {
      const body = Object.freeze(JSON.parse(JSON.stringify(data[kind].get(id))));
      return { id, exists: true, data: () => body, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    return { docs, size: docs.length, empty: docs.length === 0, metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function notify(kind) {
    subs[kind].forEach((s) => s.next(snapshot(kind)));
  }

  function maybeFail(op) {
    const i = failures.findIndex((f) => f.op === op);
    if (i !== -1) {
      const [f] = failures.splice(i, 1);
      throw { code: f.code, message: f.code };
    }
  }

  return {
    data,
    calls,
    subs,
    fail(op, code) {
      failures.push({ op, code });
    },
    // A write made by someone else (the other person's browser).
    external(kind, id, body) {
      if (body === null) data[kind].delete(id);
      else data[kind].set(id, body);
      notify(kind);
    },
    collection(kind) {
      return {
        doc(id) {
          if (!S.isValidId(id)) throw new TypeError(`bad document id: ${id}`);
          return {
            async set(body) {
              calls.push(["set", kind, id, body]);
              maybeFail("set");
              data[kind].set(id, body);
              notify(kind);
            },
            async delete() {
              calls.push(["delete", kind, id]);
              maybeFail("delete");
              data[kind].delete(id);
              notify(kind);
            },
          };
        },
        onSnapshot(next, error) {
          const sub = { next, error };
          subs[kind].push(sub);
          const cached = { docs: [], size: 0, empty: true, metadata: { fromCache: true, hasPendingWrites: false } };
          if (cacheOnly) {
            setTimeout(() => next(cached), 0);
          } else if (cacheFirst) {
            setTimeout(() => next(cached), 0);
            setTimeout(() => setTimeout(() => next(snapshot(kind)), 0), 0);
          } else {
            setTimeout(() => next(snapshot(kind)), 0);
          }
          return () => subs[kind].splice(subs[kind].indexOf(sub), 1);
        },
      };
    },
  };
}

// ---------- normalize ----------

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

test("cleanItem keeps unknown fields and fills defaults", () => {
  const t = S.cleanItem("tasks", { name: "", future: "kept" }, "t1");
  assert.equal(t.id, "t1");
  assert.equal(t.name, "Untitled");
  assert.equal(t.future, "kept");
  assert.deepEqual(t.history, []);
});

test("toDoc drops the id and undefined values", () => {
  assert.deepEqual(S.toDoc({ id: "a", name: "x", gone: undefined }), { name: "x" });
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

// ---------- shared store ----------

test("shared store waits for every list, then follows live changes", async () => {
  const db = fakeDb();
  db.data.tasks.set("t1", { name: "Clean gutters", frequency: 6, frequencyUnit: "months" });
  const store = S.createSharedStore({ db });
  const updates = [];
  store.subscribe((s) => updates.push(s));
  assert.equal(updates.length, 0, "nothing before data arrives");
  await tick();
  assert.equal(updates.length, 1, "one update once all three lists loaded");
  assert.equal(updates[0].tasks[0].id, "t1");
  assert.equal(updates[0].tasks[0].name, "Clean gutters");

  db.external("vendors", "v1", { name: "Ace", trade: "HVAC" });
  assert.equal(updates.at(-1).vendors[0].name, "Ace");
  db.external("tasks", "t1", null);
  assert.equal(updates.at(-1).tasks.length, 0);
});

test("shared store writes documents named by id", async () => {
  const db = fakeDb();
  const store = S.createSharedStore({ db });
  let seen;
  store.subscribe((s) => (seen = s));
  await tick();

  await store.put("tasks", { id: "t1", name: "Filter", frequency: 3, frequencyUnit: "months", history: [] });
  const [op, kind, id, body] = db.calls[0];
  assert.deepEqual([op, kind, id], ["set", "tasks", "t1"]);
  assert.equal("id" in body, false);
  assert.equal(body.name, "Filter");
  assert.equal(seen.tasks[0].id, "t1");

  await store.remove("tasks", "t1");
  assert.deepEqual(db.calls[1], ["delete", "tasks", "t1"]);
  assert.equal(seen.tasks.length, 0);
});

test("shared store retries a write once after a transient failure", async () => {
  const db = fakeDb();
  const store = S.createSharedStore({ db });
  store.subscribe(() => {});
  await tick();
  db.fail("set", "unavailable");
  await store.put("vendors", { id: "v1", name: "Ace" });
  assert.equal(db.calls.length, 2);
  assert.equal(db.data.vendors.get("v1").name, "Ace");

  db.fail("set", "invalid_argument");
  await assert.rejects(store.put("vendors", { id: "v2", name: "Bob" }), (e) => e.code === "invalid_argument");
});

test("shared store replaceAll removes what the backup doesn't have", async () => {
  const db = fakeDb();
  db.data.tasks.set("old", { name: "Old task" });
  db.data.tasks.set("keep", { name: "Keep me" });
  const store = S.createSharedStore({ db });
  let seen;
  store.subscribe((s) => (seen = s));
  await tick();
  await store.replaceAll({ tasks: [{ id: "keep", name: "Kept and renamed" }, { id: "new", name: "New" }] });
  assert.deepEqual(seen.tasks.map((t) => [t.id, t.name]), [["keep", "Kept and renamed"], ["new", "New"]]);
});

test("shared store resubscribes when the connection dies, and reports revoked access", async () => {
  const db = fakeDb();
  const store = S.createSharedStore({ db });
  const errors = [];
  store.subscribe(() => {}, (e) => errors.push(e.code));
  await tick();
  db.subs.tasks[0].error({ code: "unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(db.subs.tasks.length, 2, "a fresh listener was opened");
  assert.deepEqual(errors, []);
  db.subs.vendors[0].error({ code: "revoked" });
  assert.deepEqual(errors, ["revoked"]);
});

test("shared store passes identity and downloads through", async () => {
  const user = {
    can: async (name) => (name === "data.write" ? true : null),
    id: async () => "u_me",
    profiles: async (ids) => Object.fromEntries(ids.map((id) => [id, { id, name: "Sam", isMe: id === "u_me" }])),
  };
  const saved = [];
  const downloads = { save: async (req) => (saved.push(req), { status: "saved" }) };
  const store = S.createSharedStore({ db: fakeDb(), user, downloads });
  assert.equal(await store.canWrite(), true);
  assert.equal(await store.me(), "u_me");
  assert.equal((await store.people(["u_me"])).u_me.isMe, true);
  assert.deepEqual(await store.people([]), {});
  await store.saveFile("backup.json", "{}");
  assert.deepEqual(saved, [{ filename: "backup.json", data: "{}" }]);

  assert.equal(await store.canSaveFile(), true);

  // Identity and downloads can arrive later than the data, or not at all.
  const bare = S.createSharedStore({ db: fakeDb(), user: Promise.resolve(null), downloads: Promise.resolve(null) });
  assert.equal(await bare.canWrite(), null);
  assert.equal(await bare.me(), null);
  assert.deepEqual(await bare.people(["u_x"]), {});
  assert.equal(await bare.canSaveFile(), false);
  await assert.rejects(bare.saveFile("b.json", "{}"), (e) => e.code === "unavailable");
});

test("shared store ignores an empty cached list until the server confirms it", async () => {
  const db = fakeDb({ cacheFirst: true });
  db.data.tasks.set("t1", { name: "Filter" });
  const store = S.createSharedStore({ db });
  const updates = [];
  store.subscribe((s) => updates.push(s.tasks.length));
  await tick();
  assert.deepEqual(updates, [], "an empty cached snapshot isn't shown");
  await tick();
  assert.deepEqual(updates, [1], "the confirmed snapshot is");
});

test("shared store accepts an empty cached list after a grace period", async () => {
  const db = fakeDb({ cacheOnly: true });
  const store = S.createSharedStore({ db, cacheGraceMs: 20 });
  const updates = [];
  store.subscribe((s) => updates.push(s.tasks.length));
  await tick();
  assert.deepEqual(updates, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(updates, [0]);
});

// ---------- open ----------

test("open picks the backend for where the page is running", async () => {
  const local = await S.open({ win: {}, storage: memoryStorage() });
  assert.equal(local.mode, "local");

  const signedOut = await S.open({ win: { claude: { use: async () => null } } });
  assert.equal(signedOut.mode, "unavailable");

  const db = fakeDb();
  const shared = await S.open({ win: { claude: { use: async (name) => (name === "db" ? db : null) } } });
  assert.equal(shared.mode, "shared");

  // A chat artifact's window.claude has no use(): treat it as a normal page.
  const chat = await S.open({ win: { claude: { complete() {} } }, storage: memoryStorage() });
  assert.equal(chat.mode, "local");
});
