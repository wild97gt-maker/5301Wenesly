(function () {
  "use strict";

  const L = window.HomeLogic;
  const STORAGE_KEY = "house-maintenance-tracker:v1";

  // Common tasks seeded on first visit so the list isn't empty. They have no
  // "last serviced" date yet, so they show up as "Not yet serviced".
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

  // ---------- State & persistence ----------

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    return { tasks: [], projects: [], vendors: [] };
  }

  function normalize(data) {
    const s = emptyState();
    if (data && typeof data === "object") {
      if (Array.isArray(data.tasks)) s.tasks = data.tasks.map((t) => ({ history: [], ...t }));
      if (Array.isArray(data.projects)) s.projects = data.projects;
      if (Array.isArray(data.vendors)) s.vendors = data.vendors;
    }
    return s;
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      /* storage unavailable: run in-memory */
    }
    if (raw === null) {
      const s = emptyState();
      s.tasks = STARTER_TASKS.map(([name, category, frequency, frequencyUnit]) => ({
        id: uid(), name, category, location: "", frequency, frequencyUnit,
        lastServiced: "", vendorId: "", notes: "", history: [],
      }));
      return s;
    }
    try {
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.error("Could not read saved data", e);
      return emptyState();
    }
  }

  let state = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert("Could not save data in this browser. Use Export backup to keep a copy.");
    }
    render();
  }

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

  const STATUS_LABEL = {
    overdue: "Overdue",
    "due-soon": "Due soon",
    ok: "Up to date",
    never: "Not yet serviced",
  };

  // ---------- Rendering ----------

  function render() {
    renderTasks();
    renderProjects();
    renderVendors();
    renderCategoryList();
  }

  function renderSummary(sorted) {
    const counts = { overdue: 0, "due-soon": 0, never: 0, ok: 0 };
    sorted.forEach(({ info }) => counts[info.status]++);
    $("#summary").innerHTML = ["overdue", "due-soon", "never", "ok"]
      .map((s) => `<button class="stat ${s}" data-filter="${s}">
          <span class="num">${counts[s]}</span><span class="lbl">${STATUS_LABEL[s]}</span>
        </button>`)
      .join("");
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
          ${vendor && vendor.phone ? `<div class="sub"><a href="tel:${esc(vendor.phone)}">${esc(vendor.phone)}</a></div>` : ""}</td>
        <td><div class="actions">
          <button class="small primary" data-action="service" data-id="${task.id}">Mark done</button>
          <button class="small" data-action="edit-task" data-id="${task.id}">Edit</button>
        </div></td>
      </tr>`;
    }).join("");

    $("#task-empty").hidden = rows.length > 0;
    $("#task-empty").textContent = state.tasks.length
      ? "No tasks match your search."
      : "No maintenance tasks yet. Add one to get started.";
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

    $("#project-cards").innerHTML = list.map((p) => {
      const vendor = vendorById(p.vendorId);
      const statusClass = p.status === "Done" ? "ok" : p.status === "In progress" ? "due-soon" : "neutral";
      const late = p.status !== "Done" && p.targetDate && L.daysBetween(L.todayString(), p.targetDate) < 0;
      const money = [
        p.budget !== "" && p.budget != null ? `Budget ${fmtMoney(p.budget)}` : "",
        p.actualCost !== "" && p.actualCost != null ? `Spent ${fmtMoney(p.actualCost)}` : "",
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
        <div class="card-actions"><button class="small" data-action="edit-project" data-id="${p.id}">Edit</button></div>
      </article>`;
    }).join("");

    $("#project-empty").hidden = list.length > 0;
    $("#project-empty").textContent = state.projects.length ? "No projects match your search." : "No projects yet.";
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

  function renderVendors() {
    const query = $("#vendor-search").value.trim();
    const list = state.vendors
      .filter((v) => matches(v, query, ["name", "trade", "contact", "phone", "email", "notes"]))
      .sort((a, b) => (a.trade || "").localeCompare(b.trade || "") || a.name.localeCompare(b.name));

    $("#vendor-cards").innerHTML = list.map((v) => {
      const usedBy = state.tasks.filter((t) => t.vendorId === v.id).map((t) => t.name);
      const url = safeUrl(v.website);
      const rating = Number(v.rating) || 0;
      return `<article class="card">
        <h3>${esc(v.name)}</h3>
        <div class="meta">
          ${v.trade ? `<span class="badge neutral">${esc(v.trade)}</span>` : ""}
          ${rating ? `<span class="stars" title="${rating} of 5">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>` : ""}
        </div>
        ${v.contact ? `<div>${esc(v.contact)}</div>` : ""}
        ${v.phone ? `<div><a href="tel:${esc(v.phone)}">${esc(v.phone)}</a></div>` : ""}
        ${v.email ? `<div><a href="mailto:${esc(v.email)}">${esc(v.email)}</a></div>` : ""}
        ${url ? `<div><a href="${esc(url)}" target="_blank" rel="noopener">${esc(v.website)}</a></div>` : ""}
        ${usedBy.length ? `<div class="sub">Handles: ${usedBy.map(esc).join(", ")}</div>` : ""}
        ${v.notes ? `<div class="notes">${esc(v.notes)}</div>` : ""}
        <div class="card-actions"><button class="small" data-action="edit-vendor" data-id="${v.id}">Edit</button></div>
      </article>`;
    }).join("");

    $("#vendor-empty").hidden = list.length > 0;
    $("#vendor-empty").textContent = state.vendors.length ? "No vendors match your search." : "No preferred vendors yet.";
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

  // ---------- Generic edit dialogs ----------

  function setupEditor({ dialogId, collection, defaults, beforeSave }) {
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
      dialog.querySelector("[data-delete]").hidden = !item;
      dialog.showModal();
      form.elements[0].focus();
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      for (const k of Object.keys(data)) if (typeof data[k] === "string") data[k] = data[k].trim();
      const list = state[collection];
      if (editingId) {
        const idx = list.findIndex((x) => x.id === editingId);
        const updated = { ...list[idx], ...data };
        if (beforeSave) beforeSave(updated, list[idx]);
        list[idx] = updated;
      } else {
        const created = { id: uid(), ...defaults(), ...data };
        if (beforeSave) beforeSave(created, null);
        list.push(created);
      }
      dialog.close();
      save();
    });

    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-delete]").addEventListener("click", () => {
      const item = state[collection].find((x) => x.id === editingId);
      if (!item || !confirm(`Delete "${item.name}"?`)) return;
      state[collection] = state[collection].filter((x) => x.id !== editingId);
      if (collection === "vendors") {
        // Unlink the deleted vendor everywhere it was referenced.
        state.tasks.forEach((t) => { if (t.vendorId === editingId) t.vendorId = ""; });
        state.projects.forEach((p) => { if (p.vendorId === editingId) p.vendorId = ""; });
      }
      dialog.close();
      save();
    });

    return open;
  }

  const openTask = setupEditor({
    dialogId: "#task-dialog",
    collection: "tasks",
    defaults: () => ({ name: "", category: "", location: "", frequency: 1, frequencyUnit: "months",
      lastServiced: "", vendorId: "", notes: "", history: [] }),
    beforeSave: (task) => { task.frequency = Math.max(1, parseInt(task.frequency, 10) || 1); },
  });

  const openProject = setupEditor({
    dialogId: "#project-dialog",
    collection: "projects",
    defaults: () => ({ name: "", status: "Planned", priority: "Medium", targetDate: "", budget: "",
      actualCost: "", vendorId: "", notes: "" }),
  });

  const openVendor = setupEditor({
    dialogId: "#vendor-dialog",
    collection: "vendors",
    defaults: () => ({ name: "", trade: "", contact: "", phone: "", email: "", website: "", rating: "", notes: "" }),
  });

  // ---------- Log service dialog ----------

  const serviceDialog = $("#service-dialog");
  const serviceForm = $("#service-form");
  let servicingId = null;

  function openService(task) {
    servicingId = task.id;
    serviceForm.reset();
    fillVendorSelects(serviceForm);
    serviceForm.elements.date.value = L.todayString();
    serviceForm.elements.vendorId.value = task.vendorId || "";
    serviceDialog.querySelector("[data-task-name]").textContent = task.name;
    const history = [...(task.history || [])].sort((a, b) => b.date.localeCompare(a.date));
    serviceDialog.querySelector("[data-history]").innerHTML = history.length
      ? history.map((h) => `<li>
          <span class="when">${fmtDate(h.date)}</span>
          <span class="what">${[vendorName(h.vendorId), h.notes].filter(Boolean).map(esc).join(" — ") || "&nbsp;"}</span>
          <span>${h.cost !== "" && h.cost != null ? fmtMoney(h.cost) : ""}</span>
        </li>`).join("")
      : '<li class="sub">No service logged yet.</li>';
    serviceDialog.showModal();
  }

  serviceForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const task = state.tasks.find((t) => t.id === servicingId);
    if (!task) return serviceDialog.close();
    const entry = {
      date: serviceForm.elements.date.value,
      cost: serviceForm.elements.cost.value,
      vendorId: serviceForm.elements.vendorId.value,
      notes: serviceForm.elements.notes.value.trim(),
    };
    task.history = [...(task.history || []), entry];
    // Last serviced is the most recent logged date, so back-dating an old
    // entry doesn't move the schedule backwards.
    if (!task.lastServiced || entry.date > task.lastServiced) task.lastServiced = entry.date;
    serviceDialog.close();
    save();
  });
  serviceDialog.querySelector("[data-cancel]").addEventListener("click", () => serviceDialog.close());

  // ---------- Events ----------

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
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

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case "service": openService(state.tasks.find((t) => t.id === id)); break;
      case "edit-task": openTask(state.tasks.find((t) => t.id === id)); break;
      case "edit-project": openProject(state.projects.find((p) => p.id === id)); break;
      case "edit-vendor": openVendor(state.vendors.find((v) => v.id === id)); break;
    }
  });

  $("#export-data").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `house-maintenance-${L.todayString()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#import-data").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.tasks)) throw new Error("Not a tracker backup file");
      if (!confirm("Replace all current data with this backup?")) return;
      state = normalize(data);
      save();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });

  // Persist the starter tasks on first run, then draw.
  save();
})();
