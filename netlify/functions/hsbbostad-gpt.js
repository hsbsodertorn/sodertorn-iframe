// netlify/functions/hsbbostad-gpt.js
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// 1) server-side systemprompt (stil + policy)
const SYS_PROMPT = `
du är hsb bostads kundsupport och avsändare i chatten. svara alltid kort, tydligt och omtänksamt.
skriv 'brf' och 'brf:er' med gemener. börja bara nya meningar med versal. inga emojis.

när du får en fråga:
1. använd alltid informationen i kontexten (json-data) i första hand.
2. hänvisa till projektsida eller kundservice för aktuell tillgänglighet, ange aldrig antal lediga bostäder.
3. repetera inte samma fras flera gånger i samma svar.
4. håll en välkomnande ton: "välkommen", "vi hjälper dig gärna" etc.
5. Börja mening med stor bokstav och följ vanliga språkregler för svenska språket. 
`.trim();


// 2) ladda json-kunskapsbas från /data
const DATA_DIR = path.join(process.cwd(), "data");
const JSON_FILES = [
  "hsb-bostad.json",            // hsb bostad avsändare/roll
  "bospar.json",                // bospar-databas
  "medlem-privatperson.json",   // medlemskap privat
  "brf-ester.json"              // projekt (om du har)
].filter(f => fs.existsSync(path.join(DATA_DIR, f)));

function loadAll() {
  const items = [];
  for (const file of JSON_FILES) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
      const obj = JSON.parse(raw);

      const källa = obj.kategori || file.replace(/\.json$/,"");
      const sammanfattning = obj.sammanfattning || "";

      if (Array.isArray(obj.delar)) {
        for (const d of obj.delar) {
          items.push({
            källa,
            titel: d.titel || källa,
            nyckelord: (d.nyckelord || []).map(s => String(s).toLowerCase()),
            beskrivning: d.beskrivning || "",
            länk: d.lank || d.länk || null
          });
        }
      } else {
        // fallback om filen saknar "delar"
        items.push({
          källa,
          titel: källa,
          nyckelord: (obj.tags || []).map(s => String(s).toLowerCase()),
          beskrivning: sammanfattning,
          länk: null
        });
      }
    } catch (e) {
      console.error("kunde inte läsa", file, e);
    }
  }
  return items;
}

const KB = loadAll();

// 3) enkel keyword-retrieval
function tokenize(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9åäö\s\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreEntry(entry, queryTokens) {
  if (!entry) return 0;
  let score = 0;

  const kw = new Set(entry.nyckelord || []);
  for (const t of queryTokens) {
    if (kw.has(t)) score += 3; // stark träff på nyckelord
  }

  if (entry.beskrivning) {
    const desc = entry.beskrivning.toLowerCase();
    for (const t of queryTokens) {
      if (t.length > 3 && desc.includes(t)) score += 1;
    }
  }

  if (entry.titel) {
    const tt = entry.titel.toLowerCase();
    for (const t of queryTokens) {
      if (tt.includes(t)) score += 1;
    }
  }

  return score;
}

function retrieveContext(userText, maxItems = 5) {
  if (!userText) return "";
  const qTokens = tokenize(userText);

  const scored = KB.map(e => ({ e, s: scoreEntry(e, qTokens) }))
    .filter(x => x.s > 0)
    .sort((a,b) => b.s - a.s)
    .slice(0, maxItems)
    .map(x => x.e);

  if (scored.length === 0) return "";

  const blocks = scored.map(e => {
    const lines = [
      `källa: ${e.källa}`,
      `titel: ${e.titel}`,
      `sammanfattning: ${e.beskrivning}`
    ];
    if (e.länk) lines.push(`länk: ${e.länk}`);
    return lines.join("\n");
  });

  return [
    "följande är internt underlag från vår kunskapsbas. använd som faktastöd och svara med egna ord. citera inte ordagrant.",
    blocks.join("\n---\n")
  ].join("\n\n");
}

// 4) netlify handler
exports.handler = async function (event) {
  console.log("HSBBostad GPT-funktion anropad");

  try {
    const body = JSON.parse(event.body || "{}");
    const clientMessages = Array.isArray(body.messages) ? body.messages : [];

    // hitta senaste user-inlägg för retrieval
    const lastUser = [...clientMessages].reverse().find(m => m && m.role === "user");
    const ctx = lastUser ? retrieveContext(lastUser.content || "") : "";

    // bygg säkra meddelanden: serverns systemprompt -> kontext -> historik (utan client-system)
    const safeMessages = [{ role: "system", content: SYS_PROMPT }];
    if (ctx) {
      safeMessages.push({
        role: "system",
        content: `kontext (matchade nyckelord):\n${ctx}`
      });
    }
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
        model: "gpt-3.5-turbo",
        messages: safeMessages,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API fel:", text);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "fel från OpenAI", details: text })
      };
    }

    const data = await response.json();
    console.log("Svar från OpenAI (HSBBostad):", JSON.stringify(data));
    return { statusCode: 200, body: JSON.stringify(data) };

  } catch (error) {
    console.error("Fel i hsbbostad-gpt.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "kunde inte hämta AI-svar från HSBBostad GPT" })
    };
  }
};
