"use strict";

const vm = require("node:vm");

const requiredFiles = ["index.html", "styles.css", "app.js"];

function businessProjectName(idea) {
  return `Afacere · ${String(idea).replace(/\s+/g, " ").trim()}`.slice(0, 80);
}

function validateBusinessFiles(files) {
  const issues = requiredFiles.filter(name => typeof files[name] !== "string" || !files[name].trim())
    .map(name => `Fișierul ${name} lipsește sau este gol.`);
  const html = files["index.html"] || "";
  if (html && !/<(?:!doctype\s+html|html\b)/i.test(html)) issues.push("index.html trebuie să fie o pagină HTML completă.");
  if (html && !/href\s*=\s*["'](?:\.\/)?styles\.css(?:[?#][^"']*)?["']/i.test(html)) issues.push("index.html trebuie să folosească styles.css printr-o cale relativă.");
  if (html && !/src\s*=\s*["'](?:\.\/)?app\.js(?:[?#][^"']*)?["']/i.test(html)) issues.push("index.html trebuie să folosească app.js printr-o cale relativă.");
  if (files["app.js"]?.trim()) {
    try { new vm.Script(files["app.js"], { filename: "app.js" }); }
    catch { issues.push("app.js conține JavaScript invalid sau importuri care necesită un build."); }
  }
  return issues;
}

const contactSection = `
<section id="nova-contact" style="max-width:760px;margin:3rem auto;padding:1.5rem;border:1px solid #8885;border-radius:16px">
  <h2>Trimite o cerere</h2>
  <p>Descrie ce ai nevoie. Cererea ajunge direct la operatorul acestui site.</p>
  <form data-nova-contact>
    <p><label>Nume<br><input name="name" autocomplete="name" maxlength="120" required style="box-sizing:border-box;width:100%;padding:.8rem"></label></p>
    <p><label>Email<br><input name="email" type="email" autocomplete="email" maxlength="254" required style="box-sizing:border-box;width:100%;padding:.8rem"></label></p>
    <p><label>Mesaj<br><textarea name="message" maxlength="4000" required rows="4" style="box-sizing:border-box;width:100%;padding:.8rem"></textarea></label></p>
    <p>Datele sunt trimise operatorului acestui site pentru a răspunde cererii tale.</p>
    <button type="submit" style="padding:.8rem 1.4rem;cursor:pointer">Trimite cererea</button>
    <p data-nova-contact-status role="status" aria-live="polite"></p>
  </form>
</section>`;

function addBusinessContact(html) {
  const formPattern = /<form\b[^>]*\bdata-nova-contact(?:\s|=[^>]*|>)[\s\S]*?<\/form\s*>/i;
  const existing = html.match(formPattern)?.[0];
  const complete = existing && ["name", "email", "message"].every(name => new RegExp(`name\\s*=\\s*["']${name}["']`, "i").test(existing));
  let addition = "";
  if (existing && !complete) html = html.replace(formPattern, contactSection);
  else if (!existing) addition = contactSection;
  if (!/src\s*=\s*["'](?:\.\/)?nova-contact\.js["']/i.test(html)) addition += '\n<script src="./nova-contact.js" defer></script>\n';
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${addition}</body>`) : html + addition;
}

const contactScript = `(() => {
  const endpoint = new URL("contact", document.currentScript.src).href;
  const attach = () => document.querySelectorAll("form[data-nova-contact]").forEach(form => {
    let status = form.querySelector("[data-nova-contact-status]");
    if (!status) { status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); form.append(status); }
    form.addEventListener("submit", async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!form.reportValidity()) return;
      const fields = new FormData(form), button = form.querySelector("button[type=submit],input[type=submit]");
      if (button?.disabled) return;
      const payload = { name: fields.get("name"), email: fields.get("email"), message: fields.get("message") };
      if (button) button.disabled = true;
      status.textContent = "Se trimite cererea…";
      try {
        const response = await fetch(endpoint, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Cererea nu a putut fi trimisă.");
        status.textContent = "Cererea a fost înregistrată."; form.reset();
      } catch (error) { status.textContent = error.message || "Cererea nu a putut fi trimisă. Încearcă din nou."; }
      finally { if (button) button.disabled = false; }
    }, true);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach, { once: true }); else attach();
})();`;

function normalizeBusinessContact(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Completează formularul de contact."), { status: 400 });
  const value = {};
  for (const [name, maximum] of [["name", 120], ["email", 254], ["message", 4000]]) {
    if (typeof body[name] !== "string" || !body[name].trim() || body[name].trim().length > maximum) throw Object.assign(new Error("Completează numele, emailul și mesajul în limitele formularului."), { status: 400 });
    value[name] = body[name].trim();
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.email)) throw Object.assign(new Error("Adresa de email nu este validă."), { status: 400 });
  return value;
}

module.exports = { requiredFiles, businessProjectName, validateBusinessFiles, addBusinessContact, contactScript, normalizeBusinessContact };
