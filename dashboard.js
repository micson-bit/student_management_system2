"use strict";

const pageRole = document.body.dataset.dashboard;
const expectedRole = pageRole === "student" ? "student" : document.body.dataset.staffRole;
const state = { user: null, students: [], attendance: {}, ownAttendance: {} };
const todayKey = () => new Date().toISOString().slice(0, 10);
const dateLabel = (date) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
const shortDateLabel = (key) => {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(year, month - 1, day));
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const setStatusText = (present) => present ? "Present" : "Absent";

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}
function addRecords(records, keyedByEmail) {
  const result = {};
  for (const record of records) {
    const identity = keyedByEmail ? record.email : state.user.email;
    result[record.day] ||= {};
    result[record.day][identity] = { status: record.status, timestamp: record.timestamp };
  }
  return result;
}
function ownRecordToday() { return state.ownAttendance[todayKey()]?.[state.user.email]; }

async function start() {
  const { user } = await request("/api/auth/me");
  if (!user || user.role !== expectedRole) { window.location.replace("index.html"); return; }
  state.user = user;
  document.querySelectorAll("[data-today]").forEach((element) => { element.textContent = dateLabel(new Date()); });
  document.querySelectorAll("[data-user-name]").forEach((element) => { element.textContent = user.name || user.email; });
  document.querySelectorAll("[data-first-name]").forEach((element) => { element.textContent = (user.name || "student").split(/\s+/)[0]; });
  document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
    await request("/api/auth/logout", { method: "POST" });
    window.location.href = "index.html";
  }));

  const own = await request("/api/attendance");
  state.ownAttendance = addRecords(own.records, false);
  if (pageRole === "student") return startStudent();
  const [roster, schoolAttendance] = await Promise.all([request("/api/roster"), request("/api/attendance?scope=school")]);
  state.students = roster.students;
  state.attendance = addRecords(schoolAttendance.records, true);
  startStaff();
}

function startStudent() {
  const button = document.querySelector("#checkin-button");
  function render() {
    const myAttendance = ownRecordToday();
    const presentDays = Object.values(state.ownAttendance).filter((day) => day[state.user.email]?.status === "present").length;
    document.querySelector("#student-present-count").textContent = String(presentDays);
    document.querySelector("#student-stats-foot").textContent = presentDays ? `You've checked in ${presentDays} ${presentDays === 1 ? "day" : "days"} so far.` : "Your attendance history starts today.";
    document.querySelector("#checkin-title").textContent = myAttendance?.status === "present" ? "You're marked present!" : "Ready to check in?";
    document.querySelector("#checkin-description").textContent = myAttendance?.status === "present" ? "Your attendance for today has been recorded." : "Confirm that you are here for class today.";
    button.disabled = myAttendance?.status === "present";
    button.innerHTML = myAttendance?.status === "present" ? "<span aria-hidden=\"true\">âœ“</span> Present for today" : "<span aria-hidden=\"true\">âœ“</span> Mark me present";
    document.querySelector("#checkin-note").textContent = myAttendance?.status === "present" ? `Checked in at ${new Date(myAttendance.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Your check-in is saved for today only.";
    const history = document.querySelector("#student-history");
    history.innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setDate(date.getDate() - index);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const record = state.ownAttendance[key]?.[state.user.email];
      const present = record?.status === "present";
      const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
      const label = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
      const detail = present ? new Date(record.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "No check-in recorded";
      return `<div class="history-row"><span class="history-day">${day}</span><span class="history-date">${label}</span><span class="history-detail">${detail}</span><span class="status-badge ${present ? "present" : "absent"}">${setStatusText(present)}</span></div>`;
    }).join("");
  }
  button.addEventListener("click", async () => {
    try { const record = await request("/api/attendance/checkin", { method: "POST" }); state.ownAttendance[record.day] ||= {}; state.ownAttendance[record.day][state.user.email] = record; render(); }
    catch (error) { window.alert(error.message); }
  });
  render();
}

function startStaff() {
  const rosterBody = document.querySelector("#roster-body");
  const search = document.querySelector("#roster-search");
  const addForm = document.querySelector("#add-student-form");
  const staffCheckInButton = document.querySelector("#staff-checkin-button");
  function renderStaffCheckIn() {
    const checkedIn = ownRecordToday()?.status === "present";
    document.querySelector("#staff-checkin-status").textContent = checkedIn ? "You are marked present for today." : "You have not checked in today.";
    staffCheckInButton.disabled = checkedIn;
    staffCheckInButton.innerHTML = checkedIn ? "âœ“ &nbsp; Present for today" : "âœ“ &nbsp; Mark me present";
  }
  staffCheckInButton.addEventListener("click", async () => {
    try { const record = await request("/api/attendance/checkin", { method: "POST" }); state.ownAttendance[record.day] ||= {}; state.ownAttendance[record.day][state.user.email] = record; renderStaffCheckIn(); }
    catch (error) { window.alert(error.message); }
  });
  function renderRoster() {
    const allStudents = state.students.slice().sort((a, b) => a.name.localeCompare(b.name));
    const today = todayKey();
    const todayRecords = state.attendance[today] || {};
    const presentCount = allStudents.filter((student) => todayRecords[student.email]?.status === "present").length;
    const query = search.value.trim().toLowerCase();
    const filtered = allStudents.filter((student) => `${student.name} ${student.email}`.toLowerCase().includes(query));
    document.querySelector("#total-count").textContent = String(allStudents.length);
    document.querySelector("#present-count").textContent = String(presentCount);
    document.querySelector("#absent-count").textContent = String(allStudents.length - presentCount);
    document.querySelector("#roster-summary").textContent = `${allStudents.length} ${allStudents.length === 1 ? "student" : "students"}`;
    rosterBody.innerHTML = filtered.map((student) => {
      const present = todayRecords[student.email]?.status === "present";
      const initials = student.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      const joinedAt = student.joinedAt || today;
      const daysTracked = Math.max(1, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${joinedAt}T00:00:00Z`)) / 86400000) + 1);
      const presentDates = Object.entries(state.attendance).filter(([date, records]) => date >= joinedAt && date <= today && records[student.email]?.status === "present").map(([date]) => date).sort();
      const lastDate = presentDates.at(-1);
      const lastRecord = lastDate ? state.attendance[lastDate][student.email] : null;
      const lastCheckIn = lastRecord?.timestamp ? `${shortDateLabel(lastDate)} Â· ${new Date(lastRecord.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : lastDate ? shortDateLabel(lastDate) : "Never";
      return `<tr><td><span class="student-cell"><span class="student-avatar">${escapeHtml(initials)}</span><strong>${escapeHtml(student.name)}</strong></span></td><td>${escapeHtml(student.email)}</td><td>${escapeHtml(shortDateLabel(joinedAt))}</td><td class="count-cell present-total">${presentDates.length}</td><td class="count-cell absent-total">${Math.max(0, daysTracked - presentDates.length)}</td><td>${escapeHtml(lastCheckIn)}</td><td><span class="status-badge ${present ? "present" : "absent"}"><i></i>${setStatusText(present)}</span></td></tr>`;
    }).join("");
    document.querySelector("#empty-state").classList.toggle("is-hidden", allStudents.length > 0);
    document.querySelector("#empty-state").textContent = allStudents.length && !filtered.length ? "No students match that search." : "No students in the roster yet. Add students to start tracking attendance.";
    document.querySelector(".table-wrap").classList.toggle("is-hidden", allStudents.length === 0);
  }
  document.querySelector("#show-add-student").addEventListener("click", () => { addForm.classList.toggle("is-hidden"); if (!addForm.classList.contains("is-hidden")) document.querySelector("#new-student-name").focus(); });
  document.querySelector("#save-student").addEventListener("click", async () => {
    const nameInput = document.querySelector("#new-student-name");
    const emailInput = document.querySelector("#new-student-email");
    const name = nameInput.value.trim(); const email = emailInput.value.trim().toLowerCase();
    if (name.length < 2) { nameInput.setCustomValidity("Enter the student's name."); nameInput.reportValidity(); nameInput.setCustomValidity(""); return; }
    if (!emailInput.validity.valid || !email) { emailInput.reportValidity(); return; }
    try {
      const result = await request("/api/roster", { method: "POST", body: JSON.stringify({ name, email }) });
      state.students.push(result.student); nameInput.value = ""; emailInput.value = ""; renderRoster();
    } catch (error) { emailInput.setCustomValidity(error.message); emailInput.reportValidity(); emailInput.setCustomValidity(""); }
  });
  search.addEventListener("input", renderRoster);
  renderRoster(); renderStaffCheckIn();
}

start().catch((error) => {
  if (error.message.includes("Sign in")) { window.location.replace("index.html"); return; }
  document.body.insertAdjacentHTML("afterbegin", `<p role="alert" style="margin:1rem;padding:1rem;background:#fff1e6;color:#8a3d00">${escapeHtml(error.message)} Reload the page to retry.</p>`);
});
