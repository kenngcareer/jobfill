const FIELDS = [
  "firstName","lastName","email","phone","city","country",
  "linkedin","website","github","yearsExperience","currentCompany",
  "currentTitle","workAuth","sponsorship","gender","ethnicity",
  "veteran","disability","salary","coverLetter"
];

const statusEl = document.getElementById("status");
function flash(msg) {
  statusEl.textContent = msg;
  setTimeout(() => (statusEl.textContent = ""), 2200);
}

async function load() {
  const data = await chrome.storage.local.get("profile");
  const p = data.profile || {};
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (el && p[f] != null) el.value = p[f];
  }
}

async function save() {
  const p = {};
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (el) p[f] = el.value;
  }
  await chrome.storage.local.set({ profile: p });
  flash("Saved");
}

async function autofill() {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__jobFillRun?.() ?? 0,
    });
    const count = res?.result ?? 0;
    flash(count ? `Filled ${count} field${count === 1 ? "" : "s"}` : "No matching fields found");
  } catch (e) {
    flash("Can't run on this page");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("fill").addEventListener("click", autofill);
load();
