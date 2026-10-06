(function () {
  "use strict";

  const L = window.HomeLogic;
  const S = window.HomeStore;

  // Common tasks offered on an empty tracker. They have no "last serviced"
  // date yet, so they show up as "Not yet serviced".
  const STARTER_TASKS = [
    ["Replace HVAC filter", "HVAC", 3, "months"],
    ["HVAC professional tune-up", "HVAC", 1, "years"],
    ["Test smoke & CO detectors", "Safety", 1, "months"],
    ["Replace smoke detector batteries", "Safety", 1, "years"],
    ["Flush water heater", "Plumbing", 1, "years"],
    ["Clean gutters", "Exterior", 6, "months"],
    ["Clean dryer vent", "Appliances", 1, "years"],
    ["Replace fridge water filter", "Appliances", 6, "months"],
  ];

  function starterTasks() {
    return STARTER_TASKS.map(([name, category, frequency, frequencyUnit]) => ({
      id: S.uid(), name, category, location: "", frequency, frequencyUnit,
      lastServiced: "", vendorId: "", notes: "", history: [],
    }));
  }

  // ---------- State ----------

  let state = S.emptyState();
  let store = null;
  let ready = false;
  let readOnly = false;
  let myId = null;

  // ---------- Helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtDate(str) {
    const d = L.parseDate(str);
    return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
  }

  function fmtMoney(n) {
    if (n === "" || n === null || n === undefined || isNaN(Number(n))) return "";
    return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function vendorById(id) {
    return state.vendors.find((v) => v.id === id);
  }

  function vendorName(id) {
    const v = vendorById(id);
    return v ? v.name : "";
  }

  function matches(obj, query, fields) {
    if (!query) return true;
    const q = query.toLowerCase();
    return fields.some((f) => String(obj[f] ?? "").toLowerCase().includes(q));
  }

  function safeUrl(url) {
    if (!url) return "";
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
      const u = new URL(withScheme);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
    } catch (e) {
      return "";
    }
  }

  const STATUS_LABEL = {
    overdue: "Overdue",
    "due-soon": "Due soon",
    ok: "Up to date",
    never: "Not yet serviced",
  };

  // ---------- Feedback: toast, banner, confirm ----------

  let toastTimer = null;
  function toast(message, kind = "info") {
    const el = $("#toast");
    el.textContent = message;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), kind === "error" ? 8000 : 3000);
  }

  function showBanner(message) {
    const el = $("#banner");
    el.textContent = message;
    el.hidden = !message;
  }

  // alert() and confirm() don't work inside Claude's artifact viewer, so
  // confirmations use an in-page dialog.
  const confirmDialog = $("#confirm-dialog");
  function askConfirm({ title, message, confirmLabel }) {
    confirmDialog.querySelector("[data-confirm-title]").textContent = title;
    confirmDialog.querySelector("[data-confirm-message]").textContent = message;
    confirmDialog.querySelector("[data-confirm-ok]").textContent = confirmLabel;
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true });
    });
  }
  $("#confirm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    confirmDialog.close("ok");
  });
  confirmDialog.querySelector("[data-cancel]").addEventListener("click", () => confirmDialog.close("cancel"));

  function setReadOnly(value) {
    readOnly = value;
    document.body.classList.toggle("read-only", value);
    if (value) {
      showBanner("You can view this tracker but not change it. Ask the person who shared it to give you edit access.");
    }
  }

  // Runs a save and reports failures. Writes show up on screen right away;
  // this only has to deal with the ones that didn't stick.
  async function commit(promise) {
    try {
      await promise;
      return true;
    } catch (err) {
      console.error(err);
      const code = err && err.code;
      if (code === "invalid_argument") {
        setReadOnly(true);
        toast("That change wasn't saved. You don't have edit access to this tracker.", "error");
      } else if (code === "quota_exceeded") {
        toast("The tracker is full. Delete some old items, then try again.", "error");
      } else if (code === "resource_exhausted") {
        toast("Too many changes at once. Wait a moment and try again.", "error");
      } else if (code === "revoked") {
        toast("Your access to this tracker changed. Reload the page.", "error");
      } else {
        toast((err && err.message) || "That change wasn't saved. Try again.", "error");
      }
      return false;
    }
  }

  // ---------- Rendering ----------

  function render() {
    renderTasks();
    renderProjects();
    renderVendors();
    renderCategoryList();
  }

  function renderSummary(sorted) {
    if (!ready) {
      $("#summary").innerHTML = "";
      return;
    }
    const counts = { overdue: 0, "due-soon": 0, never: 0, ok: 0 };
    sorted.forEach(({ info }) => counts[info.status]++);
    const active = $("#task-filter").value;
    $("#summary").innerHTML = ["overdue", "due-soon", "never", "ok"]
      .map((s) => `<button class="stat ${s}${active === s ? " active" : ""}" data-filter="${s}" aria-pressed="${active === s}">
          <span class="num">${counts[s]}</span><span class="lbl">${STATUS_LABEL[s]}</span>
        </button>`)
      .join("");
  }

  function setEmpty(id, message, showStarter) {
    const el = $(id);
    el.hidden = !message;
    if (!message) return;
    el.querySelector("[data-msg]").textContent = message;
    const starter = el.querySelector("[data-action=add-starters]");
    if (starter) starter.hidden = !showStarter;
  }

  function renderTasks() {
    const today = L.todayString();
    const sorted = L.sortTasksByUrgency(state.tasks, today);
    renderSummary(sorted);

    const query = $("#task-search").value.trim();
    const filter = $("#task-filter").value;
    const rows = sorted.filter(({ task, info }) =>
      (filter === "all" || info.status === filter) &&
      matches({ ...task, vendor: vendorName(task.vendorId) }, query, ["name", "category", "location", "notes", "vendor"])
    );

    $("#task-rows").innerHTML = rows.map(({ task, info }) => {
      const vendor = vendorById(task.vendorId);
      const sub = [task.category, task.location].filter(Boolean).map(esc).join(" · ");
      return `<tr>
        <td><div class="task-name">${esc(task.name)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</td>
        <td data-label="Frequency">${esc(L.describeFrequency(task.frequency, task.frequencyUnit))}</td>
        <td data-label="Last serviced">${fmtDate(task.lastServiced)}</td>
        <td data-label="Next due">${info.nextDue ? fmtDate(info.nextDue) : "—"}
          ${info.nextDue ? `<div class="sub">${esc(L.describeDaysUntil(info.daysUntil))}</div>` : ""}</td>
        <td data-label="Status"><span class="badge ${info.status}">${STATUS_LABEL[info.status]}</span></td>
        <td data-label="Vendor">${vendor ? esc(vendor.name) : '<span class="sub">—</span>'}
          ${vendor && vendor.phone ? `<div class="sub">${esc(vendor.phone)}</div>` : ""}</td>
        <td><div class="actions">
          <button class="small primary" data-action="service" data-id="${esc(task.id)}" data-write>Mark done</button>
          <button class="small" data-action="history" data-id="${esc(task.id)}">History</button>
          <button class="small" data-action="edit-task" data-id="${esc(task.id)}" data-write>Edit</button>
        </div></td>
      </tr>`;
    }).join("");

    $("#task-table").hidden = rows.length === 0;
    if (!ready) setEmpty("#task-empty", "Loading your tracker…", false);
    else if (!state.tasks.length) setEmpty("#task-empty", "No maintenance tasks yet. Add your own, or start with common household tasks.", true);
    else if (!rows.length) setEmpty("#task-empty", "No tasks match your search.", false);
    else setEmpty("#task-empty", "", false);
  }

  const PROJECT_STATUS_ORDER = { "In progress": 0, Planned: 1, Idea: 2, Done: 3 };

  function renderProjects() {
    const query = $("#project-search").value.trim();
    const filter = $("#project-filter").value;
    const list = state.projects
      .filter((p) => (filter === "all" || p.status === filter) &&
        matches({ ...p, vendor: vendorName(p.vendorId) }, query, ["name", "notes", "status", "vendor"]))
      .sort((a, b) =>
        (PROJECT_STATUS_ORDER[a.status] ?? 9) - (PROJECT_STATUS_ORDER[b.status] ?? 9) ||
        (a.targetDate || "9999").localeCompare(b.targetDate || "9999") ||
        a.name.localeCompare(b.name));

    const today = L.todayString();
    $("#project-cards").innerHTML = list.map((p) => {
      const vendor = vendorById(p.vendorId);
      const statusClass = p.status === "Done" ? "ok" : p.status === "In progress" ? "due-soon" : "neutral";
      const late = p.status !== "Done" && p.targetDate && L.daysBetween(today, p.targetDate) < 0;
      const money = [
        p.budget !== "" ? `Budget ${fmtMoney(p.budget)}` : "",
        p.actualCost !== "" ? `Spent ${fmtMoney(p.actualCost)}` : "",
      ].filter(Boolean).join(" · ");
      return `<article class="card">
        <h3>${esc(p.name)}</h3>
        <div class="meta">
          <span class="badge ${statusClass}">${esc(p.status)}</span>
          <span class="badge neutral">${esc(p.priority || "Medium")} priority</span>
          ${late ? '<span class="badge overdue">Past target</span>' : ""}
        </div>
        ${p.targetDate ? `<div class="sub">Target: ${fmtDate(p.targetDate)}</div>` : ""}
        ${money ? `<div class="sub">${money}</div>` : ""}
        ${vendor ? `<div class="sub">Vendor: ${esc(vendor.name)}</div>` : ""}
        ${p.notes ? `<div class="notes">${esc(p.notes)}</div>` : ""}
        <div class="card-actions"><button class="small" data-action="edit-project" data-id="${esc(p.id)}" data-write>Edit</button></div>
      </article>`;
    }).join("");

    if (!ready) setEmpty("#project-empty", "Loading…");
    else if (!state.projects.length) setEmpty("#project-empty", "No projects yet. Add one to plan upgrades, repairs or wish-list jobs.");
    else if (!list.length) setEmpty("#project-empty", "No projects match your search.");
    else setEmpty("#project-empty", "");
  }

  function contactLine(value, href, label) {
    return `<div class="contact"><a href="${esc(href)}">${esc(value)}</a>
      <button class="copy" type="button" data-copy="${esc(value)}" aria-label="Copy ${label}">Copy</button></div>`;
  }

  function renderVendors() {
    const query = $("#vendor-search").value.trim();
    const list = state.vendors
      .filter((v) => matches(v, query, ["name", "trade", "contact", "phone", "email", "notes"]))
      .sort((a, b) => (a.trade || "").localeCompare(b.trade || "") || a.name.localeCompare(b.name));

    $("#vendor-cards").innerHTML = list.map((v) => {
      const usedBy = state.tasks.filter((t) => t.vendorId === v.id).map((t) => t.name);
      const url = safeUrl(v.website);
      const rating = Math.min(5, Math.max(0, Math.round(Number(v.rating) || 0)));
      return `<article class="card">
        <h3>${esc(v.name)}</h3>
        <div class="meta">
          ${v.trade ? `<span class="badge neutral">${esc(v.trade)}</span>` : ""}
          ${rating ? `<span class="stars" title="${rating} of 5">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>` : ""}
        </div>
        ${v.contact ? `<div>${esc(v.contact)}</div>` : ""}
        ${v.phone ? contactLine(v.phone, `tel:${v.phone.replace(/[^\d+]/g, "")}`, "phone number") : ""}
        ${v.email ? contactLine(v.email, `mailto:${v.email}`, "email address") : ""}
        ${url ? `<div><a href="${esc(url)}" target="_blank" rel="noopener">${esc(v.website)}</a></div>` : ""}
        ${usedBy.length ? `<div class="sub">Handles: ${usedBy.map(esc).join(", ")}</div>` : ""}
        ${v.notes ? `<div class="notes">${esc(v.notes)}</div>` : ""}
        <div class="card-actions"><button class="small" data-action="edit-vendor" data-id="${esc(v.id)}" data-write>Edit</button></div>
      </article>`;
    }).join("");

    if (!ready) setEmpty("#vendor-empty", "Loading…");
    else if (!state.vendors.length) setEmpty("#vendor-empty", "No preferred vendors yet. Add the plumbers, electricians and other pros you trust.");
    else if (!list.length) setEmpty("#vendor-empty", "No vendors match your search.");
    else setEmpty("#vendor-empty", "");
  }

  function renderCategoryList() {
    const cats = [...new Set(state.tasks.map((t) => t.category).filter(Boolean))].sort();
    $("#category-list").innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join("");
  }

  function fillVendorSelects(root) {
    const options = ['<option value="">— None —</option>']
      .concat([...state.vendors]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => `<option value="${esc(v.id)}">${esc(v.name)}${v.trade ? ` (${esc(v.trade)})` : ""}</option>`))
      .join("");
    root.querySelectorAll("[data-vendor-select]").forEach((sel) => (sel.innerHTML = options));
  }

  // ---------- Add / edit dialogs ----------

  function setupEditor({ dialogId, kind, noun, defaults, beforeSave }) {
    const dialog = $(dialogId);
    const form = dialog.querySelector("form");
    let editingId = null;

    function open(item) {
      editingId = item ? item.id : null;
      form.reset();
      fillVendorSelects(form);
      const values = { ...defaults(), ...(item || {}) };
      for (const el of form.elements) {
        if (el.name && el.name in values) el.value = values[el.name] ?? "";
      }
      dialog.querySelector("[data-title]").textContent = `${item ? "Edit" : "Add"} ${noun}`;
      dialog.querySelector("[data-delete]").hidden = !item;
      dialog.showModal();
      form.elements[0].focus();
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      for (const k of Object.keys(data)) if (typeof data[k] === "string") data[k] = data[k].trim();
      // Merge into the latest copy so a change someone else made meanwhile
      // (like a logged service) isn't thrown away.
      const existing = editingId && state[kind].find((x) => x.id === editingId);
      const record = existing ? { ...existing, ...data } : { ...defaults(), ...data, id: editingId || S.uid() };
      if (beforeSave) beforeSave(record);
      dialog.close();
      commit(store.put(kind, record));
    });

    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-delete]").addEventListener("click", async () => {
      const item = state[kind].find((x) => x.id === editingId);
      if (!item) return dialog.close();
      const ok = await askConfirm({
        title: `Delete ${noun}?`,
        message: `"${item.name}" will be removed${store.mode === "shared" ? " for everyone who uses this tracker" : ""}. This can't be undone.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      dialog.close();
      if (!(await commit(store.remove(kind, item.id)))) return;
      if (kind === "vendors") {
        // Unlink the deleted vendor everywhere it was referenced.
        for (const t of state.tasks.filter((t) => t.vendorId === item.id)) await commit(store.put("tasks", { ...t, vendorId: "" }));
        for (const p of state.projects.filter((p) => p.vendorId === item.id)) await commit(store.put("projects", { ...p, vendorId: "" }));
      }
      toast(`Deleted "${item.name}"`);
    });

    return open;
  }

  const openTask = setupEditor({
    dialogId: "#task-dialog",
    kind: "tasks",
    noun: "task",
    defaults: () => ({ name: "", category: "", location: "", frequency: 1, frequencyUnit: "months",
      lastServiced: "", vendorId: "", notes: "", history: [] }),
    beforeSave: (task) => { task.frequency = Math.max(1, parseInt(task.frequency, 10) || 1); },
  });

  const openProject = setupEditor({
    dialogId: "#project-dialog",
    kind: "projects",
    noun: "project",
    defaults: () => ({ name: "", status: "Planned", priority: "Medium", targetDate: "", budget: "",
      actualCost: "", vendorId: "", notes: "" }),
  });

  const openVendor = setupEditor({
    dialogId: "#vendor-dialog",
    kind: "vendors",
    noun: "vendor",
    defaults: () => ({ name: "", trade: "", contact: "", phone: "", email: "", website: "", rating: "", notes: "" }),
  });

  // ---------- Log service / history dialog ----------

  const serviceDialog = $("#service-dialog");
  const serviceForm = $("#service-form");
  let servicingId = null;

  async function renderHistory(task) {
    const list = serviceDialog.querySelector("[data-history]");
    const history = [...task.history].sort((a, b) => b.date.localeCompare(a.date));
    if (!history.length) {
      list.innerHTML = '<li class="sub">No service logged yet.</li>';
      return;
    }
    const ids = [...new Set(history.map((h) => h.by).filter(Boolean))];
    let people = {};
    try {
      people = await store.people(ids);
    } catch (e) {
      /* names are a nicety; show the history without them */
    }
    if (servicingId !== task.id) return;
    list.innerHTML = history.map((h) => {
      const p = h.by && people[h.by];
      const who = p ? (p.isMe ? "you" : p.name || "someone") : "";
      const details = [vendorName(h.vendorId), h.notes].filter(Boolean).map(esc).join(" — ");
      return `<li>
        <span class="when">${fmtDate(h.date)}</span>
        <span class="what">${details || "&nbsp;"}${who ? `<span class="by">Logged by ${esc(who)}</span>` : ""}</span>
        <span class="cost">${h.cost !== "" ? fmtMoney(h.cost) : ""}</span>
      </li>`;
    }).join("");
  }

  function openService(task, { historyOnly = false } = {}) {
    servicingId = task.id;
    serviceForm.reset();
    fillVendorSelects(serviceForm);
    serviceForm.elements.date.value = L.todayString();
    serviceForm.elements.vendorId.value = task.vendorId || "";
    serviceDialog.querySelector("[data-task-name]").textContent = task.name;
    serviceDialog.classList.toggle("history-only", historyOnly || readOnly);
    serviceDialog.querySelector("[data-history]").innerHTML = "";
    renderHistory(task);
    serviceDialog.showModal();
  }

  serviceForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const task = state.tasks.find((t) => t.id === servicingId);
    serviceDialog.close();
    if (!task) return;
    const entry = {
      date: serviceForm.elements.date.value,
      cost: serviceForm.elements.cost.value,
      vendorId: serviceForm.elements.vendorId.value,
      notes: serviceForm.elements.notes.value.trim(),
      by: myId || "",
    };
    // Last serviced is the most recent logged date, so back-dating an old
    // entry doesn't move the schedule backwards.
    const lastServiced = !task.lastServiced || entry.date > task.lastServiced ? entry.date : task.lastServiced;
    commit(store.put("tasks", { ...task, history: [...task.history, entry], lastServiced })).then((ok) => {
      if (ok) toast(`Logged "${task.name}"`);
    });
  });
  serviceDialog.querySelector("[data-cancel]").addEventListener("click", () => serviceDialog.close());

  // ---------- Events ----------

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab);
      });
      document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${tab.dataset.view}`));
    })
  );

  $("#add-task").addEventListener("click", () => openTask(null));
  $("#add-project").addEventListener("click", () => openProject(null));
  $("#add-vendor").addEventListener("click", () => openVendor(null));

  ["#task-search", "#task-filter", "#project-search", "#project-filter", "#vendor-search"].forEach((sel) =>
    $(sel).addEventListener("input", render)
  );

  $("#summary").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    const filter = $("#task-filter");
    filter.value = filter.value === btn.dataset.filter ? "all" : btn.dataset.filter;
    renderTasks();
  });

  function copyText(btn) {
    const text = btn.dataset.copy;
    const fallback = () => {
      // Select the text so it can be copied by hand.
      const target = btn.parentElement.querySelector("a");
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast("Selected. Copy it with your device's copy command.");
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) return fallback();
    navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`), fallback);
  }

  document.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) return copyText(copyBtn);
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const task = () => state.tasks.find((t) => t.id === id);
    switch (btn.dataset.action) {
      case "service": if (task()) openService(task()); break;
      case "history": if (task()) openService(task(), { historyOnly: true }); break;
      case "edit-task": if (task()) openTask(task()); break;
      case "edit-project": openProject(state.projects.find((p) => p.id === id)); break;
      case "edit-vendor": openVendor(state.vendors.find((v) => v.id === id)); break;
      case "add-starters": {
        btn.disabled = true;
        for (const t of starterTasks()) if (!(await commit(store.put("tasks", t)))) break;
        btn.disabled = false;
        break;
      }
    }
  });

  $("#export-data").addEventListener("click", async () => {
    if (!store || store.mode === "unavailable") return;
    const json = JSON.stringify(state, null, 2);
    try {
      await store.saveFile(`house-maintenance-${L.todayString()}.json`, json);
    } catch (err) {
      if (err && err.code !== "declined") toast("The backup couldn't be saved. Try again.", "error");
    }
  });

  $("#import-data").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !store) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.tasks)) throw new Error("not a backup");
    } catch (err) {
      toast("That file isn't a House Maintenance backup. Choose a .json file made with Export backup.", "error");
      return;
    }
    const ok = await askConfirm({
      title: "Replace all data?",
      message: `Everything in this tracker will be replaced with the ${data.tasks.length} tasks and other items in "${file.name}"${store.mode === "shared" ? ", for everyone who uses it" : ""}.`,
      confirmLabel: "Replace",
    });
    if (!ok) return;
    if (await commit(store.replaceAll(data))) toast("Backup imported");
  });

  // ---------- Start ----------

  async function start() {
    render();
    store = await S.open({ win: window, storage: safeLocalStorage(), starter: starterTasks });

    if (store.mode === "unavailable") {
      // Inside Claude, but the shared data isn't reachable (usually signed out).
      document.body.classList.add("no-data");
      showBanner("The shared tracker couldn't load here. Open it from your Claude link while signed in to Claude.");
      return;
    }

    $("#storage-note").textContent = store.mode === "shared"
      ? "Shared: changes sync for everyone who has access."
      : "Saved in this browser only.";
    $("#mode-chip").hidden = store.mode !== "shared";
    $("#export-data").hidden = true;
    store.canSaveFile().then((ok) => ($("#export-data").hidden = !ok));

    store.subscribe(
      (next) => {
        state = next;
        ready = true;
        document.body.classList.add("ready");
        render();
      },
      (err) => {
        console.error(err);
        showBanner(err && err.code === "revoked"
          ? "Your access to this tracker changed. Reload the page to continue."
          : "Live updates stopped. Reload the page to see the latest changes.");
      }
    );

    const [canWrite, me] = await Promise.all([store.canWrite(), store.me()]);
    myId = me;
    if (canWrite === false) setReadOnly(true);
  }

  function safeLocalStorage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  start();
})();
