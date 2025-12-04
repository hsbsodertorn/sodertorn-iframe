// netlify/functions/hsbbostad-gpt.js

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

/* =========================
   0) Firebase Admin init
   ========================= */

if (!admin.apps.length) {
  // FIREBASE_SERVICE_ACCOUNT ska vara en JSON-sträng i Netlify env
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

/* =========================
   1) server-side systemprompt
   ========================= */

const SYS_PROMPT = `
Du är en digital kundvärd för HSB Bostad.

Din uppgift är att hjälpa privatpersoner att förstå och hitta rätt information om:
- HSB Bostads bostadsprojekt, nyproduktion och utbud
- Boköp, intresseanmälan, köprocess, tilldelning och avtal
- HSB bospar, grundläggande regler och hur bospar kopplas till att köpa bostad
- Kontaktvägar till HSB Bostad och var användaren kan läsa mer på webben

Stil och ton:
- Skriv på svenska
- Skriv sakligt, tydligt och omtänksamt
- Använd "du" till användaren, professionellt men varmt
- Skriv alltid meningar med stor begynnelsebokstav
- Skriv "brf" och "brf:er" med gemener
- Använd korta stycken och gärna punktlistor när det blir tydligare
- Inga emojis

Användning av kontext:
- Du får en "kontext" med utdrag från interna texter (json-data).
- Använd den i första hand, men formulera svaret med egna ord.
- Om något saknas i kontexten: svara med generell och säker information om HSB Bostad, och var tydlig med att detaljer kan kontrolleras på hsb.se eller via kundservice.
- Hitta inte på exakta siffror, datum eller priser.

Personuppgifter och integritet:
- Be aldrig aktivt om personnummer, kontonummer eller andra känsliga personuppgifter.
- Om användaren ändå skriver personliga uppgifter, svara sakligt utan att upprepa dem mer än nödvändigt.
- Om ärendet kräver handläggning eller insyn i personliga uppgifter, hänvisa till HSB Bostads ordinarie kundservicekanaler.

Begränsningar:
- Ge inte juridisk eller finansiell rådgivning.
- Ge inte bindande besked om avtal, ekonomi eller individuella ärenden.
- Ange inte exakta antal lediga bostäder eller liknande realtidsdata. Hänvisa istället till projektsidor eller kundservice för aktuell status.

Svarsmall:
1) Bekräfta frågan kort.
2) Ge 1–3 tydliga svar eller råd baserat på kontexten och din kunskap om HSB Bostad.
3) Avsluta med ett konkret nästa steg (t.ex. länk till hsb.se, projektsida eller kontaktväg).
`.trim();

/* =========================
   2) projekt-/kunskapsprofil (kan utökas)
   ========================= */

// En generell profil + ev. projektspecifik text. Du kan lägga till fler rader/projekt senare.
const PROJECT_PROFILE = [
  "HSB Bostad utvecklar och säljer nyproducerade bostadsrätter i Stockholmsområdet.",
  "Fokus ligger på långsiktigt hållbara boenden, goda kommunikationer och genomtänkta gemensamma ytor.",
  "För detaljer om ett specifikt projekt, se projektsidan på hsb.se eller kontakta ansvarig mäklare eller HSB Bostads kundservice."
].join("\n");

/* =========================
   3) ladda json-kunskapsbas från /data
   ========================= */

const DATA_DIR = path.join(process.cwd(), "data");
const JSON_FILES = [
  "hsb-bostad.json",
  "bospar.json",
  "medlemprivatperson.json",
  "brf-ester.json"
].filter((f) => fs.existsSync(path.join(DATA_DIR, f)));

function loadAll() {
  const items = [];
  for (const file of JSON_FILES) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf8");
      const obj = JSON.parse(raw);
      const källa = (obj.kategori || file.replace(/\.json$/, "")).toLowerCase();
      const sammanfattning = obj.sammanfattning || "";

      if (Array.isArray(obj.delar)) {
        for (const d of obj.delar) {
          items.push({
            källa,
            titel: d.titel || källa,
            nyckelord: (d.nyckelord || []).map((s) => String(s).toLowerCase()),
            beskrivning: d.beskrivning || "",
            länk: d.lank || d.länk || obj.projekt_url || null
          });
        }
      } else {
        items.push({
          källa,
          titel: källa,
          nyckelord: (obj.tags || []).map((s) => String(s).toLowerCase()),
          beskrivning: sammanfattning,
          länk: obj.projekt_url || null
        });
      }
    } catch (e) {
      console.error("Kunde inte läsa kunskapsfil:", file, e);
    }
  }
  return items;
}

const KB = loadAll();

/* =========================
   4) retrieval-logik
   ========================= */

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9åäö\s\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const SOURCE_BOOST = { "brf-ester": 5, "hsb-bostad": 2 };
const INTENT_BOOST = {
  mäklare: 3,
  visning: 3,
  prospekt: 3,
  specifikation: 2,
  inflytt: 3,
  tillträde: 3,
  besiktning: 3,
  eftermarknad: 3,
  tillval: 3,
  inredningsval: 3,
  ekonomisk: 2,
  upplåtelse: 2,
  garage: 2,
  laddplats: 2,
  avgift: 2,
  priser: 2,
  skola: 1
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
  const scored = KB.map((e) => ({ e, s: scoreEntry(e, qTokens) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxItems)
    .map((x) => x.e);

  const blocks = scored.map((e) => {
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

  return blocks.length
    ? [header, blocks.join("\n---\n")].join("\n\n")
    : header;
}

/* =========================
   5) availability-guard
   ========================= */

function looksLikeAvailability(q) {
  const s = (q || "").toLowerCase();
  return (
    /(ledig|tillgänglig|finns det|antal|hur många|köpa nu|just nu)/.test(s) &&
    /(lägenhet|bostad|brf)/.test(s)
  );
}

/* =========================
   6) Netlify handler med Firestore-loggning
   ========================= */

exports.handler = async function (event) {
  console.log("HSB Bostad GPT-funktion anropad");

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const sessionIdRaw = (body.sessionId || "").toString();
    const userMessage = (body.userMessage || "").toString().trim();

    if (!userMessage) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing userMessage" })
      };
    }

    const safeSessionId =
      sessionIdRaw ||
      `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const convRef = db
      .collection("hsbBostad_conversations")
      .doc(safeSessionId);
    const messagesRef = convRef.collection("messages");

    // Hämta tidigare meddelanden för historik
    const prevSnap = await messagesRef.orderBy("index", "asc").get();
    const history = [];
    prevSnap.forEach((doc) => {
      const d = doc.data();
      if (d.role === "user" || d.role === "assistant") {
        history.push({ role: d.role, content: d.content });
      }
    });

    // Bygg kontext från JSON-kunskapsbasen
    const ctx = retrieveContext(userMessage);

    // Bygg meddelanden till modellen
    const messages = [{ role: "system", content: SYS_PROMPT }];

    if (looksLikeAvailability(userMessage)) {
      messages.push({
        role: "system",
        content:
          "policy: ange inte antal lediga bostäder. hänvisa till projektsida på hsb.se eller kundservice för aktuell tillgänglighet."
      });
    }

    if (ctx) {
      messages.push({
        role: "system",
        content: `kontext:\n${ctx}`
      });
    }

    // Lägg till historik (utan tidigare systemmeddelanden)
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }

    // Sist: aktuellt användarmeddelande
    messages.push({ role: "user", content: userMessage });

    // Anropa OpenAI
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 450
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
    const assistantReply =
      data.choices?.[0]?.message?.content?.trim() ||
      "Jag kunde tyvärr inte generera ett svar just nu.";

    // Logga till Firestore
    const now = admin.firestore.FieldValue.serverTimestamp();
    const baseIndex = prevSnap.size; // antal tidigare meddelanden

    const batch = db.batch();

    const userDocRef = messagesRef.doc();
    batch.set(userDocRef, {
      role: "user",
      content: userMessage,
      createdAt: now,
      index: baseIndex
    });

    const assistantDocRef = messagesRef.doc();
    batch.set(assistantDocRef, {
      role: "assistant",
      content: assistantReply,
      createdAt: now,
      index: baseIndex + 1,
      model: "gpt-3.5-turbo"
    });

    batch.set(
      convRef,
      {
        sessionId: safeSessionId,
        createdAt: now,
        updatedAt: now,
        lastUserMessage: userMessage,
        lastAssistantMessage: assistantReply,
        messageCount: prevSnap.size + 2
      },
      { merge: true }
    );

    await batch.commit();

    // Returnera i samma struktur som frontend förväntar sig
    return {
      statusCode: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: assistantReply
            }
          }
        ]
      })
    };
  } catch (error) {
    console.error("Fel i hsbbostad-gpt.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "kunde inte hämta AI-svar från HSBBostad GPT"
      })
    };
  }
};
