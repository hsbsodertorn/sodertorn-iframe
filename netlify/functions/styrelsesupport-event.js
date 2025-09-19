// server: tar emot länkklick, dubblar värdet och loggar event
const admin = require("firebase-admin");
function initAdmin() {
  if (admin.apps.length) return;
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (svc) {
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } else {
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
    const { conversationId, url } = JSON.parse(event.body || "{}");
    if (!conversationId || !url) {
      return { statusCode: 400, body: "conversationId och url krävs" };
    }

    const col = db.collection("chattlogg_styrelsesupport");
    const snap = await col.where("conversationId", "==", conversationId)
                          .orderBy("tid", "desc").limit(1).get();
    if (snap.empty) return { statusCode: 404, body: "not found" };

    const ref = snap.docs[0].ref;
    await db.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data();
      const länkar = (data.länkar || []).map(l => {
        if (l.url === url && !l.klickad) return { ...l, klickad: true, värde: (l.värde || 1) * 2 };
        return l;
      });
      const värde_score = länkar.reduce((s,l)=>s+(l.värde||1),0);
      tx.update(ref, { länkar, värde_score });
    });

    await db.collection("chatt_events").add({
      conversationId,
      tid: admin.firestore.FieldValue.serverTimestamp(),
      typ: "link_click",
      payload: { url }
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

