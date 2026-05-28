// JobFill content script. Exposes window.__jobFillRun() which the popup invokes.
(() => {
  // Map profile keys to regex patterns matched against field label/name/id/placeholder.
  // Order matters — more specific rules go first so they win over broad ones.
  const RULES = [
    { key: "firstName", patterns: [/first\s*name/i, /given\s*name/i, /\bfname\b/i] },
    { key: "lastName", patterns: [/last\s*name/i, /family\s*name/i, /surname/i, /\blname\b/i] },
    { key: "email", patterns: [/e[-\s]?mail/i] },
    { key: "phone", patterns: [/phone/i, /mobile/i, /telephone/i] },
    { key: "linkedin", patterns: [/linkedin/i] },
    { key: "github", patterns: [/github/i] },
    { key: "website", patterns: [/website|portfolio|personal\s*site|^url$/i] },
    // Specific screening questions FIRST so broad rules ("country", "company") don't steal them.
    { key: "workAuth", patterns: [/legally\s*authori[sz]ed?\s*to\s*work/i, /authori[sz]ed?\s*to\s*work/i, /legally\s*allowed\s*to\s*work/i, /work\s*authori[sz]ation/i, /right\s*to\s*work/i] },
    { key: "sponsorship", patterns: [/visa\s*sponsorship/i, /require.*sponsor/i, /need.*sponsor/i, /sponsor(ship)?/i, /immigration\s*sponsorship/i] },
    { key: "workedHere", patterns: [/have\s*you\s*(ever\s*)?worked\s*(for|at)/i, /previously\s*(employed|worked)/i, /former\s*employee/i, /past\s*employee/i] },
    { key: "relativesAtCompany", patterns: [/family\s*member|relative|personal\s*relationship/i, /know\s*anyone\s*(who\s*)?(works|working)/i, /referr?al\s*from\s*(an\s*)?employee/i] },
    { key: "outsideActivity", patterns: [/outside\s*business\s*activit/i, /side\s*business/i, /(advisory|consulting|board)\s*role/i, /other\s*employment/i, /conflict\s*of\s*interest/i] },
    { key: "acknowledge", patterns: [/acknowledg/i, /\bconsent\b/i, /agree.*(privacy|terms|process)/i, /privacy\s*policy/i, /processing\s*of.*(personal\s*)?data/i, /i\s*certify/i] },
    { key: "yearsExperience", patterns: [/years.*(experience|exp)/i, /how\s*many\s*years/i, /\bYOE\b/i] },
    { key: "currentCompany", patterns: [/current\s*(company|employer)/i, /^company$/i, /employer/i] },
    { key: "currentTitle", patterns: [/current\s*(title|role|position)/i, /job\s*title/i, /^title$/i] },
    { key: "city", patterns: [/^city$/i, /\bcity\b|\btown\b/i] },
    { key: "country", patterns: [/^country$/i, /country\s*(of\s*)?(residence|resid)/i, /\bcountry\b/i] },
    { key: "gender", patterns: [/gender/i] },
    { key: "ethnicity", patterns: [/ethnic|race|hispanic/i] },
    { key: "veteran", patterns: [/veteran/i] },
    { key: "disability", patterns: [/disabilit/i] },
    { key: "salary", patterns: [/salary|compensation|expected\s*pay|desired\s*pay/i] },
    { key: "coverLetter", patterns: [/cover\s*letter/i, /why.*(interested|this\s*role|us|company)/i, /tell\s*us.*yourself/i, /additional\s*information/i] },
  ];

  // Build label/context text for an element from every signal we can find.
  function labelTextFor(el) {
    const parts = [];

    if (el.labels && el.labels.length) {
      for (const l of el.labels) parts.push(l.innerText || "");
    }
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) parts.push(lbl.innerText || "");
      } catch {}
    }

    // Closest fieldset's own legend (this is how LinkedIn / Greenhouse group Yes/No).
    const fs = el.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector(":scope > legend");
      if (legend) parts.push(legend.innerText || "");
    }

    // Walk up a few levels for label / role=group / aria-labelledby containers.
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 6) {
      if (p.tagName === "LABEL") parts.push(p.innerText || "");
      if (p.getAttribute && p.getAttribute("role") === "group") {
        const lblId = p.getAttribute("aria-labelledby");
        if (lblId) {
          for (const id of lblId.split(/\s+/)) {
            const n = document.getElementById(id);
            if (n) parts.push(n.innerText || "");
          }
        }
        const aria = p.getAttribute("aria-label");
        if (aria) parts.push(aria);
      }
      p = p.parentElement;
      depth++;
    }

    const aria = el.getAttribute("aria-label") || "";
    const aribby = el.getAttribute("aria-labelledby");
    if (aribby) {
      for (const id of aribby.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) parts.push(n.innerText || "");
      }
    }

    parts.push(
      aria,
      el.getAttribute("placeholder") || "",
      el.getAttribute("name") || "",
      el.getAttribute("id") || "",
      el.getAttribute("data-test") || "",
      el.getAttribute("data-qa") || "",
      el.getAttribute("data-automation-id") || ""
    );

    // Collapse whitespace and strip the trailing "Required" suffix LinkedIn duplicates.
    return parts.join(" | ").replace(/\s+/g, " ").replace(/\brequired\b/gi, "").trim();
  }

  function matchKey(text) {
    for (const r of RULES) {
      for (const p of r.patterns) {
        if (p.test(text)) return r.key;
      }
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function fillSelect(el, value) {
    const target = String(value).toLowerCase();
    let chosen = null;
    for (const opt of el.options) {
      const t = (opt.text || "").toLowerCase();
      const v = (opt.value || "").toLowerCase();
      if (t === target || v === target) { chosen = opt; break; }
    }
    if (!chosen) {
      for (const opt of el.options) {
        const t = (opt.text || "").toLowerCase();
        if (t && (t.includes(target) || target.includes(t))) { chosen = opt; break; }
      }
    }
    if (!chosen) return false;
    el.value = chosen.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // For each radio in the group, look at its own label (Yes / No / etc.) and pick a match.
  function fillRadioGroup(els, value) {
    const target = String(value).toLowerCase().trim();
    if (!target) return false;

    let chosen = null;
    for (const r of els) {
      const lbl = labelTextFor(r).toLowerCase();
      const v = (r.value || "").toLowerCase();
      if (v === target || lbl === target) { chosen = r; break; }
    }
    if (!chosen) {
      for (const r of els) {
        const lbl = labelTextFor(r).toLowerCase();
        const v = (r.value || "").toLowerCase();
        if (v.includes(target) || target.includes(v) || lbl.includes(target)) { chosen = r; break; }
      }
    }
    if (!chosen) return false;

    // Prefer clicking the associated <label> — works best with React-controlled radios.
    let clickTarget = null;
    if (chosen.id) {
      try { clickTarget = document.querySelector(`label[for="${CSS.escape(chosen.id)}"]`); } catch {}
    }
    if (!clickTarget) clickTarget = chosen.closest("label");
    if (clickTarget) clickTarget.click();
    else chosen.click();

    chosen.checked = true;
    chosen.dispatchEvent(new Event("input", { bubbles: true }));
    chosen.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function isTruthyAck(value) {
    return /^(yes|true|1|on|i\s*acknowledge|acknowledge|agree|accept|consent)/i.test(String(value).trim());
  }

  function isFillableInput(el) {
    if (el.disabled) return false;
    const t = (el.type || "").toLowerCase();
    if (["hidden", "file", "submit", "button", "reset", "image"].includes(t)) return false;
    // For radios / checkboxes, LinkedIn frequently visually-hides the native input
    // via clip-path/off-screen positioning while the label is the real click target,
    // which makes offsetParent null. Keep them in scope regardless.
    if (t === "radio" || t === "checkbox") return true;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    return true;
  }

  async function run() {
    const { profile } = await chrome.storage.local.get("profile");
    if (!profile) {
      alert("JobFill: save your profile in the extension popup first.");
      return 0;
    }

    let filled = 0;
    const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter(isFillableInput);

    // Group radios by name.
    const radioGroups = {};
    for (const el of inputs) {
      if (el.type === "radio" && el.name) {
        radioGroups[el.name] = radioGroups[el.name] || [];
        radioGroups[el.name].push(el);
      }
    }

    const handledRadioNames = new Set();

    for (const el of inputs) {
      const text = labelTextFor(el);
      if (!text) continue;
      const key = matchKey(text);
      if (!key) continue;
      const value = profile[key];
      if (value === undefined || value === null || value === "") continue;

      try {
        if (el.tagName === "SELECT") {
          if (fillSelect(el, value)) filled++;
        } else if (el.type === "radio") {
          if (el.name && handledRadioNames.has(el.name)) continue;
          if (el.name) handledRadioNames.add(el.name);
          const group = (el.name && radioGroups[el.name]) || [el];
          if (fillRadioGroup(group, value)) filled++;
        } else if (el.type === "checkbox") {
          const want = isTruthyAck(value);
          if (el.checked !== want) {
            // Click the label when possible — React-controlled checkboxes need it.
            let clickTarget = null;
            if (el.id) {
              try { clickTarget = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch {}
            }
            if (!clickTarget) clickTarget = el.closest("label");
            (clickTarget || el).click();
            filled++;
          }
        } else {
          if (el.value && el.value.trim().length) continue; // don't overwrite existing
          setNativeValue(el, String(value));
          filled++;
        }
      } catch {}
    }

    return filled;
  }

  window.__jobFillRun = run;
})();
