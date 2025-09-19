// server: tar emot loggrad och skriver till Firestore med admin SDK
const admin = require("firebase-admin");
const crypto = require("crypto");

function initAdmin() {
  if (admin.apps.length) return;
  // rekommenderat: lägg service account JSON i Netlify env var FIREBASE_SERVICE_ACCOUNT
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (svc) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } else {
    // fallback: application default credentials
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}
initAdmin();

const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  try {
    const body = JSON.parse(event.body || "{}");

    const systemText = body.systemprompt_text || "";
    const hash = crypto.createHash("sha256").update(systemText).digest("hex");

    const doc = {
      conversationId: body.conversationId,
      fraga: body.fraga,
      svar: body.svar,
      tid: admin.firestore.FieldValue.serverTimestamp(),

      kategorier: body.kategorier || [],
      labels: body.labels || [],
      kunskapslucka: !!body.kunskapslucka,
      sammanfattning: body.sammanfattning || null,
      betyg: body.betyg ?? null,
      säkerhetsuppskattning: body.säkerhetsuppskattning || "låg",

      systemprompt: {
        version: body.systemprompt_version || "unknown",
        hash,
        utdrag: systemText.slice(0, 120)
      },

      länkar: (body.länkar || []).map(l => ({
        url: l.url, titel: l.titel || null, källa: l.källa || "extern",
        visad: !!l.visad, klickad: !!l.klickad, värde: typeof l.värde==="number" ? l.värde : 1
      })),
      värde_score: (body.länkar || []).reduce((s,l)=>s+(typeof l.värde==="number"?l.värde:1),0)
    };

    await db.collection("chattlogg_styrelsesupport").add(doc);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

