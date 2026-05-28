// JobFill content script. Exposes window.__jobFillRun() which the popup invokes.
(() => {
  // Map profile keys to regex patterns matched against field label/name/id/placeholder.
  const RULES = [
    { key: "firstName", patterns: [/first\s*name/i, /given\s*name/i, /\bfname\b/i] },
    { key: "lastName", patterns: [/last\s*name/i, /family\s*name/i, /surname/i, /\blname\b/i] },
    { key: "email", patterns: [/e[-\s]?mail/i] },
    { key: "phone", patterns: [/phone/i, /mobile/i, /telephone/i] },
    { key: "city", patterns: [/^city$/i, /city|town/i] },
    { key: "country", patterns: [/country/i] },
    { key: "linkedin", patterns: [/linkedin/i] },
    { key: "website", patterns: [/website|portfolio|personal\s*site|url/i] },
    { key: "github", patterns: [/github/i] },
    { key: "yearsExperience", patterns: [/years.*(experience|exp)/i, /how\s*many\s*years/i, /\bYOE\b/i] },
    { key: "currentCompany", patterns: [/current\s*(company|employer)/i, /^company$/i, /employer/i] },
    { key: "currentTitle", patterns: [/current\s*(title|role|position)/i, /job\s*title/i, /^title$/i] },
    { key: "workAuth", patterns: [/authori[sz]ed?\s*to\s*work/i, /legally\s*(allowed|authorized)/i, /work\s*authori[sz]ation/i] },
    { key: "sponsorship", patterns: [/sponsor(ship)?/i, /visa/i, /require\s*(immigration|sponsorship)/i] },
    { key: "gender", patterns: [/gender/i] },
    { key: "ethnicity", patterns: [/ethnic|race|hispanic/i] },
    { key: "veteran", patterns: [/veteran/i] },
    { key: "disability", patterns: [/disabilit/i] },
    { key: "salary", patterns: [/salary|compensation|expected\s*pay|desired\s*pay/i] },
    { key: "coverLetter", patterns: [/cover\s*letter/i, /why.*(interested|this\s*role|us|company)/i, /tell\s*us.*yourself/i, /additional\s*information/i] },
  ];

  function labelTextFor(el) {
    const parts = [];
    if (el.labels && el.labels.length) {
      for (const l of el.labels) parts.push(l.innerText || "");
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.innerText || "");
    }
    // ancestor label/legend/fieldset
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 4) {
      if (p.tagName === "LABEL") parts.push(p.innerText || "");
      const lg = p.querySelector?.("legend");
      if (lg) parts.push(lg.innerText || "");
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
      el.getAttribute("data-qa") || ""
    );
    return parts.join(" | ").replace(/\s+/g, " ").trim();
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
        if (t.includes(target) || target.includes(t)) { chosen = opt; break; }
      }
    }
    if (!chosen) return false;
    el.value = chosen.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fillRadioGroup(els, value) {
    const target = String(value).toLowerCase();
    for (const r of els) {
      const lbl = labelTextFor(r).toLowerCase();
      const v = (r.value || "").toLowerCase();
      if (v === target || lbl.includes(target)) {
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
        r.dispatchEvent(new Event("click", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  async function run() {
    const { profile } = await chrome.storage.local.get("profile");
    if (!profile) {
      alert("JobFill: save your profile in the extension popup first.");
      return 0;
    }

    let filled = 0;
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter((el) => !el.disabled && el.type !== "hidden" && el.type !== "file" && el.type !== "submit" && el.type !== "button" && el.offsetParent !== null);

    // Group radios by name
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
          if (handledRadioNames.has(el.name)) continue;
          handledRadioNames.add(el.name);
          if (fillRadioGroup(radioGroups[el.name] || [el], value)) filled++;
        } else if (el.type === "checkbox") {
          const want = /^(yes|true|1)$/i.test(String(value));
          if (el.checked !== want) {
            el.click();
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
