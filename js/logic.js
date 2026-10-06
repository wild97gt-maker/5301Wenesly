// Pure date/scheduling helpers. Loaded as a classic script in the browser
// (exposed as window.HomeLogic) and via require() in the Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HomeLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  const UNITS = ["days", "weeks", "months", "years"];
  const DUE_SOON_DAYS = 14;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  // Dates are stored as "YYYY-MM-DD" strings and treated as local calendar days.
  function parseDate(str) {
    if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
    const [y, m, d] = str.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return date;
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function todayString(now = new Date()) {
    return formatDate(now);
  }

  // Adds an interval, clamping month/year math to the end of the month
  // (e.g. Jan 31 + 1 month = Feb 28/29).
  function addInterval(dateStr, amount, unit) {
    const date = parseDate(dateStr);
    const n = Number(amount);
    if (!date || !Number.isFinite(n) || n <= 0 || !UNITS.includes(unit)) return null;
    if (unit === "days" || unit === "weeks") {
      const days = unit === "weeks" ? n * 7 : n;
      return formatDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
    }
    const months = unit === "years" ? n * 12 : n;
    const targetMonth = date.getMonth() + months;
    const lastDay = new Date(date.getFullYear(), targetMonth + 1, 0).getDate();
    return formatDate(new Date(date.getFullYear(), targetMonth, Math.min(date.getDate(), lastDay)));
  }

  function daysBetween(fromStr, toStr) {
    const a = parseDate(fromStr);
    const b = parseDate(toStr);
    if (!a || !b) return null;
    // Use UTC to avoid DST shifting the result by an hour.
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / MS_PER_DAY);
  }

  function nextDueDate(task) {
    if (!task.lastServiced) return null;
    return addInterval(task.lastServiced, task.frequency, task.frequencyUnit);
  }

  // Returns { status, nextDue, daysUntil } where status is one of
  // "overdue", "due-soon", "ok", or "never" (no service date recorded yet).
  function taskStatus(task, today = todayString()) {
    const nextDue = nextDueDate(task);
    if (!nextDue) return { status: "never", nextDue: null, daysUntil: null };
    const daysUntil = daysBetween(today, nextDue);
    let status = "ok";
    if (daysUntil < 0) status = "overdue";
    else if (daysUntil <= DUE_SOON_DAYS) status = "due-soon";
    return { status, nextDue, daysUntil };
  }

  function describeFrequency(amount, unit) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return "";
    const singular = unit.replace(/s$/, "");
    return n === 1 ? `Every ${singular}` : `Every ${n} ${unit}`;
  }

  function describeDaysUntil(daysUntil) {
    if (daysUntil === null || daysUntil === undefined) return "";
    if (daysUntil === 0) return "Due today";
    if (daysUntil === 1) return "Due tomorrow";
    if (daysUntil === -1) return "1 day overdue";
    if (daysUntil < 0) return `${-daysUntil} days overdue`;
    return `In ${daysUntil} days`;
  }

  const STATUS_ORDER = { overdue: 0, never: 1, "due-soon": 2, ok: 3 };

  function sortTasksByUrgency(tasks, today = todayString()) {
    return tasks
      .map((t) => ({ task: t, info: taskStatus(t, today) }))
      .sort((a, b) => {
        const s = STATUS_ORDER[a.info.status] - STATUS_ORDER[b.info.status];
        if (s !== 0) return s;
        if (a.info.daysUntil !== b.info.daysUntil) {
          return (a.info.daysUntil ?? 0) - (b.info.daysUntil ?? 0);
        }
        return a.task.name.localeCompare(b.task.name);
      });
  }

  return {
    UNITS,
    DUE_SOON_DAYS,
    parseDate,
    formatDate,
    todayString,
    addInterval,
    daysBetween,
    nextDueDate,
    taskStatus,
    describeFrequency,
    describeDaysUntil,
    sortTasksByUrgency,
  };
});
