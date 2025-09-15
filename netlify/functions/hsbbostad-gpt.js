// netlify/functions/hsbbostad-gpt.js
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

/* =========================
   1) server-side systemprompt
   ========================= */
const SYS_PROMPT = `
du är hsb bostads kundsupport för hsb brf ester. du skriver tydliga, korta svar och hjälper användaren vidare.

stil:
- skriv kort, tydligt och omtänksamt. inga emojis, inga helversaler.
- skriv "brf" och "brf:er" med gemener.
- börja bara nya meningar med versal (inte enstaka ord mitt i meningen).

kontextanvändning:
- använd i första hand informationen i "kontext" (json-data). sammanfatta med egna ord.
- om något saknas i kontexten: svara ändå med säker, generell projektfakta nedan och visa tydligt nästa steg (projektsida eller mäklarkontakt). hitta inte på detaljer.

policy:
- ange aldrig exakta antal lediga bostäder. hänvisa till projektsidan eller kundservice för aktuell tillgänglighet.

inbyggd projektfakta:
- brf ester, bromstensstaden (spånga). inflyttningsklart. 1–4 rok, ca 28–91 kvm. miljöbyggnad silver, ftx-ventilation, laddplatser, cykelparkering, grön innergård, gemensamhetslokal.
- kontakt: robert blomster, mäklarhuset. tel 073-231 38 02. e-post robert.blomster@maklarhuset.se
- projektsida: https://www.hsb.se/sok-bostad/stockholm/stockholm/projekt/ester/

svarsmall:
1) bekräfta frågan kort.
2) ge 1–3 raka svar/råd från kontext eller projektfakta.
3) avsluta med tydligt nästa steg (projektsida eller kontakt).

begränsningar:
- ge inte juridisk eller finansiell rådgivning.
- ren text utan markdown.
`.trim();

/* =========================
   2) projektprofil (kort säljprofil)
   ========================= */
const PROJECT_PROFILE = [
  "brf ester: inflyttningsklart i bromstensstaden (spånga). 1–4 rok, ca 28–91 kvm, miljöbyggnad silver.",
  "ftx-ventilation, individuell varmvattenmätning, laddplatser, cykelparkering och grön innergård.",
  "gemensamhetslokal, förråd till alla, garage under gården. goda kommunikationer (pendel till odenplan ca 11 min).",
  "kontakt mäklare: robert blomster (mäklarhuset) 073-231 38 02, robert.blomster@maklarhuset.se.",
  "projektsida: https://www.hsb.se/sok-bostad/stockholm/stockholm/projekt/ester/"
].join("\n");

/* =========================
   3) ladda json-kunskapsbas
   ========================= */
const DATA_DIR = path.join(process.cwd(), "data");
const JSON_FILES = [
  "hsb-bostad.json",
  "bospar.json",
  "medlem-privatperson.json",
  "brf-ester.json"
].filter(f => fs.existsSync(path.join(DATA_DIR, f)));

function loadAll() {
  const items = [];
  for (const file of JSON_FILES) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
      const obj = JSON.parse(raw);
      const källa = (obj.kategori || file.replace(/\.json$/,"")).toLowerCase();
      const sammanfattning = obj.sammanfattning || "";

      if (Array.isArray(obj.delar)) {
        for (const d of obj.delar) {
          items.push({
            källa,
            titel: (d.titel || källa),
            nyckelord: (d.nyckelord || []).map(s => String(s).toLowerCase()),
            beskrivning: d.beskrivning || "",
            länk: d.lank || d.länk || obj.projekt_url || null
          });
        }
      } else {
        items.push({
          källa,
          titel: källa,
          nyckelord: (obj.tags || []).map(s => String(s).toLowerCase()),
          beskrivning: sammanfattning,
          länk: obj.projekt_url || null
        });
      }
    } catch (e) {
      console.error("kunde inte läsa", file, e);
    }
  }
  return items;
}
const KB = loadAll();

/* =========================
   4) retrieval
   ========================= */
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9åäö\s\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const SOURCE_BOOST = { "brf-ester": 5, "hsb-bostad": 2 };
const INTENT_BOOST = {
  "mäklare": 3, "visning": 3, "prospekt": 3, "specifikation": 2,
  "inflytt": 3, "tillträde": 3, "besiktning": 3, "eftermarknad": 3,
  "tillval": 3, "inredningsval": 3, "ekonomisk": 2, "upplåtelse": 2,
  "garage": 2, "laddplats": 2, "avgift": 2, "priser": 2, "skola": 1
};

function scoreEntry(entry, queryTokens) {
  let score = 0;
  if (SOURCE_BOOST[entry.källa]) score += SOURCE_BOOST[entry.källa];
  const kw = new Set(entry.nyckelord || []);
  for (const t of queryTokens) {
    if (kw.has(t)) score += 3;
    if (INTENT_BOOST[t]) score += INTENT_BOOST[t];
  }
  if (entry.titel) {
    const tt = entry.titel.toLowerCase();
    for (const t of queryTokens) if (tt.includes(t)) score += 1;
  }
  if (entry.beskrivning) {
    const desc = entry.beskrivning.toLowerCase();
    for (const t of queryTokens) if (t.length > 3 && desc.includes(t)) score += 1;
  }
  return score;
}

function retrieveContext(userText, { maxItems = 6, minScore = 3 } = {}) {
  if (!userText) return PROJECT_PROFILE;
  const qTokens = tokenize(userText);
  const scored = KB.map(e => ({ e, s: scoreEntry(e, qTokens) }))
    .filter(x => x.s >= minScore)
    .sort((a,b) => b.s - a.s)
    .slice(0, maxItems)
    .map(x => x.e);

  const blocks = scored.map(e => {
    const lines = [
      `källa: ${e.källa}`,
      `titel: ${e.titel}`,
      `sammanfattning: ${e.beskrivning}`
    ];
    if (e.länk) lines.push(`länk: ${e.länk}`);
    return lines.join("\n");
  });

  const header = [
    "projektprofil:",
    PROJECT_PROFILE,
    "",
    "följande är internt underlag från vår kunskapsbas. använd som faktastöd och svara med egna ord. citera inte ordagrant."
  ].join("\n");

  return blocks.length ? [header, blocks.join("\n---\n")].join("\n\n") : header;
}

/* =========================
   5) availability-guard
   ========================= */
function looksLikeAvailability(q) {
  const s = (q || "").toLowerCase();
  return /(ledig|tillgänglig|finns det|antal|hur många|köpa nu|just nu)/.test(s)
      && /(lägenhet|bostad|brf)/.test(s);
}

/* =========================
   6) netlify handler
   ========================= */
exports.handler = async function (event) {
  console.log("HSBBostad GPT-funktion anropad");
  try {
    const body = JSON.parse(event.body || "{}");
    const clientMessages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...clientMessages].reverse().find(m => m && m.role === "user");
    const ctx = lastUser ? retrieveContext(lastUser.content || "") : PROJECT_PROFILE;

    const safeMessages = [{ role: "system", content: SYS_PROMPT }];
    if (lastUser && looksLikeAvailability(lastUser.content)) {
      safeMessages.push({
        role: "system",
        content: "policy: ange inte antal lediga bostäder. hänvisa till projektsidan eller kundservice för aktuell tillgänglighet."
      });
    }
    if (ctx) safeMessages.push({ role: "system", content: `kontext:\n${ctx}` });
    for (const m of clientMessages) {
      if (!m || m.role === "system") continue;
      safeMessages.push({ role: m.role, content: m.content });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",  // <- här kör vi 3.5 turbo
        messages: safeMessages,
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 450
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API fel:", text);
      return { statusCode: response.status, body: JSON.stringify({ error: "fel från OpenAI", details: text }) };
    }

    const data = await response.json();
    return { statusCode: 200, body: JSON.stringify(data) };

  } catch (error) {
    console.error("Fel i hsbbostad-gpt.js:", error);
    return { statusCode: 500, body: JSON.stringify({ error: "kunde inte hämta AI-svar från HSBBostad GPT" }) };
  }
};
