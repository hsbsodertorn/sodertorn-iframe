// netlify/functions/hsbbostad-gpt.js

const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

/* =========================
   0) Firebase Admin init (robust)
   ========================= */

let db = null;

(function initFirebase() {
  try {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!sa) {
      console.warn("FIREBASE_SERVICE_ACCOUNT saknas – kör utan Firestore-loggning.");
      return;
    }

    const serviceAccount = JSON.parse(sa);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    console.log("Firebase Admin init klar för HSB Bostad.");
  } catch (e) {
    console.error("Kunde inte initiera Firebase Admin – kör utan loggning:", e);
    db = null;
  }
})();

/* =========================
   1) server-side systemprompt
   ========================= */

const SYS_PROMPT = `
Du är en digital kundvärd för HSB Bostad.

Din uppgift är att hjälpa privatpersoner att förstå och hitta rätt information om:
- HSB Bostads bostadsprojekt och nyproduktion (lägenhetstyper, standard, planlösningar, gemensamma utrymmen, hållbarhet, läge, kommunikationer)
- Boköp, bospar, intresseanmälan, köprocess, tilldelning, upplåtelse, tillträde och eftermarknad
- Kontaktvägar till HSB Bostad, mäklare och var användaren kan läsa mer på webben (projektsidor på hsb.se)

Stil och ton:
- Skriv på svenska
- Skriv sakligt, tydligt och omtänksamt
- Använd "du" till användaren, professionellt men varmt
- Skriv alltid meningar med stor begynnelsebokstav
- Skriv "brf" och "brf:er" med gemener
- Använd korta stycken och gärna punktlistor när det gör svaret tydligare
- Inga emojis

Användning av kontext:
- Du får en "kontext" med utdrag från interna texter (json-data), bland annat om aktuella nyproduktionsprojekt.
- Använd den i första hand, men formulera svaret med egna ord.
- Om något saknas i kontexten: svara med generell och säker information om HSB Bostad och bostadsköp, och var tydlig med att detaljer kan kontrolleras på hsb.se eller via kundservice.
- Hitta inte på exakta siffror, datum, priser eller detaljer som inte finns i kontexten.

Mål med svaren:
- Fokusera på att beskriva själva boendet och hur det är att bo i HSB Bostads projekt (t.ex. standard, gemensamma ytor, hållbarhet, läge, vardag).
- För frågor om HSB och köpprocessen: förklara tydligt hur det brukar gå till och hur bospar kan användas.
- När det finns information om specifika projekt i kontexten: ge kort projektbeskrivning, framhäv relevanta kvaliteter och koppla till bostadsköp hos HSB.
- Ge gärna kontaktuppgifter till mäklare eller HSB samt projektsida när sådan information finns i kontexten.

Personuppgifter och integritet:
- Be aldrig aktivt om personnummer, kontonummer eller andra känsliga personuppgifter.
- Om användaren ändå skriver personliga uppgifter, svara sakligt utan att upprepa dem mer än nödvändigt.
- Om ärendet kräver handläggning eller insyn i personliga uppgifter, hänvisa till HSB Bostads ordinarie kundservicekanaler.

Begränsningar:
- Ge inte juridisk eller finansiell rådgivning.
- Ge inte bindande besked om avtal, ekonomi eller individuella ärenden.
- Ange inte exakta antal lediga bostäder eller andra realtidsuppgifter. Hänvisa istället till projektsidor på hsb.se eller kundservice för aktuell status.

Svarsmall (du behöver inte skriva siffror, men följ strukturen):
1) Bekräfta frågan kort.
2) Ge 1–3 tydliga svar eller råd baserat på kontexten och din kunskap om HSB Bostad och bostadsköp.
3) Avsluta med ett konkret nästa steg (t.ex. länk till projektsida på hsb.se, länk till hsb.se/bospar, eller kontaktuppgifter till mäklare eller kundservice).
`.trim();

/* =========================
   2) generell profil
   ========================= */

const PROJECT_PROFILE = [
  "HSB Bostad utvecklar och säljer nyproducerade bostadsrätter i Stockholmsområdet.",
  "Fokus ligger på långsiktigt hållbara boenden, bra planlösningar, gemensamma utrymmen som gör vardagen enklare, samt goda kommunikationer.",
  "För detaljer om ett specifikt projekt, se projektsidan på hsb.se eller kontakta ansvarig mäklare eller HSB Bostads kundservice."
].join("\n");

/* =========================
   3) ladda json-kunskapsbas
   ========================= */

const DATA_DIR = path.join(process.cwd(), "data");
const JSON_FILES = [
  "hsb-bostad.json",
  "bospar.json",
  "medlemprivatperson.json",
  "aktuella-nyproduktioner.json"
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
            länk: d.lank || d.länk || obj.projekt_url || null,
            kontakt: d.kontakt || null
          });
        }
      } else {
        items.push({
          källa,
          titel: källa,
          nyckelord: (obj.tags || []).map((s) => String(s).toLowerCase()),
          beskrivning: sammanfattning,
          länk: obj.projekt_url || null,
          kontakt: obj.kontakt || null
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
   4) retrieval-logik (ingen favorit-brf)
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

const SOURCE_BOOST = {
  "hsb-bostad": 2,
  "aktuella-nyproduktioner": 2
};

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
  skola: 1,
  bospar: 3,
  insats: 2,
  månadsavgift: 2
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
    if (e.kontakt) lines.push(`kontakt: ${e.kontakt}`);
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
    /(lägenhet|bostad|brf|nyproduktion|projekt)/.test(s)
  );
}

/* =========================
   6) Netlify handler (tar emot { messages } från frontend)
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

    const clientMessages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...clientMessages].reverse().find(
      (m) => m && m.role === "user"
    );

    if (!lastUser || !lastUser.content) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing user message" })
      };
    }

    const userMessage = String(lastUser.content || "").trim();

    const sessionIdRaw = (body.sessionId || "").toString();
    const safeSessionId =
      sessionIdRaw ||
      `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const ctx = retrieveContext(userMessage);

    const messages = [{ role: "system", content: SYS_PROMPT }];

    if (looksLikeAvailability(userMessage)) {
      messages.push({
        role: "system",
        content:
          "policy: ange inte exakta antal lediga bostäder eller liknande realtidsuppgifter. hänvisa istället till projektsidan på hsb.se eller kundservice för aktuell tillgänglighet."
      });
    }

    if (ctx) {
      messages.push({
        role: "system",
        content: `kontext:\n${ctx}`
      });
    }

    for (const m of clientMessages) {
      if (!m || m.role === "system") continue;
      messages.push({ role: m.role, content: m.content });
    }

    let assistantReply = "";

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 450
        })
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("OpenAI API fel:", response.status, text);
        assistantReply =
          "Jag kan tyvärr inte hämta ett fullständigt svar just nu på grund av ett tekniskt fel. Prova gärna igen om en stund eller kontakta HSB Bostads kundservice direkt.";
      } else {
        const data = await response.json();
        assistantReply =
          data.choices?.[0]?.message?.content?.trim() ||
          "Jag kunde tyvärr inte generera ett svar just nu.";
      }
    } catch (e) {
      console.error("Nätverksfel mot OpenAI:", e);
      assistantReply =
        "Jag kan tyvärr inte hämta ett fullständigt svar just nu på grund av ett tekniskt fel. Prova gärna igen om en stund eller kontakta HSB Bostads kundservice direkt.";
    }

    // 🔵 Logga till Firestore om möjligt (fel här får aldrig bryta svaret)
    if (db) {
      try {
        const now = admin.firestore.FieldValue.serverTimestamp();
        const convRef = db
          .collection("hsbBostad_conversations")
          .doc(safeSessionId);
        const messagesRef = convRef.collection("messages");

        const batch = db.batch();

        const userDocRef = messagesRef.doc();
        batch.set(userDocRef, {
          role: "user",
          content: userMessage,
          createdAt: now,
          source: "frontend"
        });

        const assistantDocRef = messagesRef.doc();
        batch.set(assistantDocRef, {
          role: "assistant",
          content: assistantReply,
          createdAt: now,
          model: "gpt-4o-mini",
          source: "backend"
        });

        batch.set(
          convRef,
          {
            sessionId: safeSessionId,
            updatedAt: now,
            lastUserMessage: userMessage,
            lastAssistantMessage: assistantReply
          },
          { merge: true }
        );

        await batch.commit();
        console.log(
          "HSB Bostad: loggade konversation i Firestore med sessionId",
          safeSessionId
        );
      } catch (e) {
        console.error(
          "HSB Bostad: kunde inte logga till Firestore (ok att ignorera):",
          e
        );
      }
    } else {
      console.log("HSB Bostad: Firestore ej init – hoppar över loggning.");
    }

    // ✅ alltid 200 till frontend, oavsett om OpenAI lyckades eller inte
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
    console.error("Fel i hsbbostad-gpt.js (yttre catch):", error);
    // även här: returnera 200 så att frontend inte triggar "Kunde inte kontakta tjänsten"
    return {
      statusCode: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content:
                "Jag kan tyvärr inte svara på din fråga just nu på grund av ett tekniskt fel. För hjälp direkt, kontakta gärna HSB Bostads kundservice."
            }
          }
        ]
      })
    };
  }
};
