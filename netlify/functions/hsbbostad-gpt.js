// netlify/functions/hsbbostad-gpt.js
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// 1) server-side systemprompt (stil + policy)
/* =========================
   1) server-side systemprompt (ester-first, service+sälj)
   ========================= */
const SYS_PROMPT = `
du är hsb bostads kundsupport och avsändare i chatten.
du är hsb bostads kundsupport för hsb brf ester. du är avsändare i chatten.

# stil
- skriv kort, tydligt och omtänksamt.
- inga emojis, inga utrop med versaler. använd aldrig HELVERSALER.
- skriv "brf" och "brf:er" med gemener.
- börja bara nya meningar med versal (inte enstaka ord mitt i meningen).
stil:
- skriv kort, tydligt och omtänksamt. inga emojis, inga HELVERSALER.
- skriv "brf" och "brf:er" med gemener. börja bara nya meningar med versal.

# använd kontexten
- använd i första hand informationen i "kontext" (json-data) som du får i systemmeddelandet.
- om kontexten inte täcker frågan: ställ max en riktad följdfråga eller ge ett neutralt, korrekt standardsvar utan att hitta på.
kontext:
- använd i första hand informationen i "kontext" (json-data). sammanfatta med egna ord, hitta inte på.
- om något saknas i kontexten: säg det kort och visa nästa steg (projektsida, kundservice eller mäklarkontakt).

# policy för tillgänglighet
tillgänglighet:
- ange aldrig exakta antal lediga bostäder. hänvisa till projektsida eller kundservice för aktuell tillgänglighet.

# innehållsprioritering (recept för varje svar)
1) bekräfta användarens ärende mycket kort (en mening).
2) ge 1–3 konkreta punkter med svar/vägledning baserat på kontexten.
3) avsluta med tydligt nästa steg (t.ex. länk/kanal/handling). repetera inte tidigare fraser.
säljtouch:
- var lösningsorienterad: förklara kort värden (planlösning, gård, miljöbyggnad, läge) när det efterfrågas.
- avsluta med ett tydligt nästa steg (t.ex. "vill du att jag skickar länk till prospekt eller mäklare?").

# längd
- 2–5 korta meningar totalt. undvik upprepningar och utfyllnad.
målgrupper:
- köpare/intressent: vägled i köpprocessen (lånelöfte, avtal, tillval, tillträde/inflytt).
- boende: hänvisa korrekt till felanmälan/eftermarknad.
- mäklare: svara sakligt om projektfakta och var underlag finns.

# säkerhet och korrekthet
- hitta inte på fakta. om något saknas i kontexten, säg det kort och hänvisa rätt.
- ge inte juridisk eller finansiell rådgivning; ge generell info och hänvisa vid behov.

# format
- ren text (ingen markdown), inga listtecken om det inte ökar tydligheten.
- använd vi-form när du skriver om hsb bostads ansvar och kommunikation.

# exempel på ton och form
användare: "vilka brf är aktuella just nu?"
svar: "välkommen. vi publicerar aktuella brf:er på projektsidan. titta där för lägenhetslistor och uppdateringar eller hör av dig till kundservice om du vill bli kontaktad. vill du att jag visar var du hittar projektsidan?"
format:
- 2–5 korta meningar. upprepa inte fraser. ren text.
`.trim();


// 2) ladda json-kunskapsbas från /data
/* =========================
   2) projektprofil (kort säljande profil överst i kontexten)
   ========================= */
const PROJECT_PROFILE = [
  "brf ester är nyproduktion med 1–4 rok och miljöbyggnad silver.",
  "ftx-ventilation och individuell varmvattenmätning.",
  "innergård med pergola och cykelrum; förråd till alla lägenheter.",
  "upplåtelseavtal före tillträde; tillval enligt katalog innan deadline."
].join("\n");

/* =========================
   3) ladda json-kunskapsbas från /data
   ========================= */
const DATA_DIR = path.join(process.cwd(), "data");
const JSON_FILES = [
  "hsb-bostad.json",            // hsb bostad avsändare/roll
  "bospar.json",                // bospar-databas
  "medlem-privatperson.json",   // medlemskap privat
  "brf-ester.json"              // projekt (om du har)
  "brf-ester.json"              // projekt (ester)
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
/* =========================
   4) retrieval: tokenisering, boostar och scoring
   ========================= */
function tokenize(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9åäö\s\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// källa- och intent-boost (ester först; mäklare/inflytt/tillval m.fl.)
const SOURCE_BOOST = {
  "brf-ester": 4,
  "hsb-bostad": 2
};
const INTENT_BOOST = {
  "mäklare": 3, "visning": 3, "prospekt": 3, "specifikation": 2,
  "inflytt": 3, "tillträde": 3, "besiktning": 3, "eftermarknad": 3,
  "tillval": 3, "inredningsval": 3, "ekonomisk": 2, "upplåtelse": 2
};

function scoreEntry(entry, queryTokens) {
  if (!entry) return 0;
  let score = 0;

  // 1) källa-boost
  if (entry.källa && SOURCE_BOOST[entry.källa]) score += SOURCE_BOOST[entry.källa];

  // 2) träff på definierade nyckelord
  const kw = new Set(entry.nyckelord || []);
  for (const t of queryTokens) {
    if (kw.has(t)) score += 3; // stark träff på nyckelord
    if (kw.has(t)) score += 3;
  }

  // 3) intent-boost (om frågan nämner viktiga ord)
  for (const t of queryTokens) {
    if (INTENT_BOOST[t]) score += INTENT_BOOST[t];
  }

  // 4) svaga signaler i titel/beskrivning
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
    "projektprofil:",
    PROJECT_PROFILE,
    "",
    "följande är internt underlag från vår kunskapsbas. använd som faktastöd och svara med egna ord. citera inte ordagrant.",
    blocks.join("\n---\n")
  ].join("\n\n");
  ].join("\n");
}

/* =========================
   5) availability-guard (fångar “ledigt/antal”-frågor)
   ========================= */
function looksLikeAvailability(q) {
  const s = (q || "").toLowerCase();
  return /(ledig|tillgänglig|finns det|antal|hur många|köpa nu|just nu)/.test(s) && /(lägenhet|bostad|brf)/.test(s);
}

// 4) netlify handler
/* =========================
   6) netlify handler
   ========================= */
exports.handler = async function (event) {
  console.log("HSBBostad GPT-funktion anropad");

  try {
    const body = JSON.parse(event.body || "{}");
    const clientMessages = Array.isArray(body.messages) ? body.messages : [];

    // hitta senaste user-inlägg för retrieval
    const lastUser = [...clientMessages].reverse().find(m => m && m.role === "user");
    const ctx = lastUser ? retrieveContext(lastUser.content || "") : "";

    // bygg säkra meddelanden: serverns systemprompt -> kontext -> historik (utan client-system)
    // bygg säkra meddelanden: systemprompt -> ev. policy-injektion -> kontext -> historik (utan client-system)
    const safeMessages = [{ role: "system", content: SYS_PROMPT }];

    if (lastUser && looksLikeAvailability(lastUser.content)) {
      safeMessages.push({
        role: "system",
        content: "policy: ange inte antal lediga bostäder. hänvisa till projektsidan eller kundservice för aktuell tillgänglighet och erbjud hjälp att peka ut rätt länk."
      });
    }

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
