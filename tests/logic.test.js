const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/logic.js");

test("parseDate rejects invalid input", () => {
  assert.equal(L.parseDate(""), null);
  assert.equal(L.parseDate("2026-02-30"), null);
  assert.equal(L.parseDate("10/06/2026"), null);
  assert.equal(L.formatDate(L.parseDate("2026-10-06")), "2026-10-06");
});

test("addInterval handles each unit", () => {
  assert.equal(L.addInterval("2026-01-01", 10, "days"), "2026-01-11");
  assert.equal(L.addInterval("2026-01-01", 2, "weeks"), "2026-01-15");
  assert.equal(L.addInterval("2026-01-15", 3, "months"), "2026-04-15");
  assert.equal(L.addInterval("2026-03-01", 1, "years"), "2027-03-01");
  assert.equal(L.addInterval("2026-12-20", 30, "days"), "2027-01-19");
});

test("addInterval clamps to end of month", () => {
  assert.equal(L.addInterval("2026-01-31", 1, "months"), "2026-02-28");
  assert.equal(L.addInterval("2028-01-31", 1, "months"), "2028-02-29");
  assert.equal(L.addInterval("2028-02-29", 1, "years"), "2029-02-28");
});

test("addInterval rejects bad frequency", () => {
  assert.equal(L.addInterval("2026-01-01", 0, "days"), null);
  assert.equal(L.addInterval("2026-01-01", 1, "fortnights"), null);
  assert.equal(L.addInterval("", 1, "days"), null);
});

test("daysBetween is DST-safe", () => {
  assert.equal(L.daysBetween("2026-03-01", "2026-03-31"), 30);
  assert.equal(L.daysBetween("2026-11-10", "2026-11-01"), -9);
});

test("taskStatus classifies tasks", () => {
  const base = { name: "Filter", frequency: 3, frequencyUnit: "months" };
  const today = "2026-10-06";
  assert.deepEqual(L.taskStatus({ ...base, lastServiced: "" }, today), {
    status: "never",
    nextDue: null,
    daysUntil: null,
  });
  assert.equal(L.taskStatus({ ...base, lastServiced: "2026-06-01" }, today).status, "overdue");
  assert.equal(L.taskStatus({ ...base, lastServiced: "2026-07-10" }, today).status, "due-soon");
  assert.equal(L.taskStatus({ ...base, lastServiced: "2026-07-06" }, today).daysUntil, 0);
  const ok = L.taskStatus({ ...base, lastServiced: "2026-09-01" }, today);
  assert.equal(ok.status, "ok");
  assert.equal(ok.nextDue, "2026-12-01");
});

test("sortTasksByUrgency puts overdue first", () => {
  const today = "2026-10-06";
  const tasks = [
    { name: "OK", frequency: 1, frequencyUnit: "years", lastServiced: "2026-09-01" },
    { name: "Never", frequency: 1, frequencyUnit: "years", lastServiced: "" },
    { name: "Late", frequency: 1, frequencyUnit: "months", lastServiced: "2026-01-01" },
    { name: "Soon", frequency: 1, frequencyUnit: "months", lastServiced: "2026-09-10" },
  ];
  assert.deepEqual(
    L.sortTasksByUrgency(tasks, today).map((x) => x.task.name),
    ["Late", "Never", "Soon", "OK"]
  );
});

test("describe helpers", () => {
  assert.equal(L.describeFrequency(1, "months"), "Every month");
  assert.equal(L.describeFrequency(6, "months"), "Every 6 months");
  assert.equal(L.describeDaysUntil(-3), "3 days overdue");
  assert.equal(L.describeDaysUntil(0), "Due today");
  assert.equal(L.describeDaysUntil(12), "In 12 days");
});
