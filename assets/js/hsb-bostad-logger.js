// assets/js/hsb-bostad-logger.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app-check.js";

// 🔑 fyll i ditt riktiga config — viktigt att projectId = ditt projekt (t.ex. "hsbsodertorn")
const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  projectId: "hsbsodertorn",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};

// initiera appen
const app = initializeApp(firebaseConfig);

// 🛡️ initiera app check om du har “enforce” på i firebase console
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("RECAPTCHA_V3_SITE_KEY"), // ersätt med din site key
    isTokenAutoRefreshEnabled: true
  });
  console.log("[hsb-bostad-logger] app check init");
} catch (e) {
  console.warn("[hsb-bostad-logger] app check ej init (ok om ej enforced)", e);
}

// firestore och auth
const db = getFirestore(app);
const auth = getAuth(app);

// 🔵 ny samling för bostadschatten
const COLLECTION = "chattlogg_bostad";

// sessions-id per flik
function getSessionId() {
  const k = "hsbBostad_sessionId";
  let id = sessionStorage.getItem(k);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(k, id);
  }
  return id;
}

// säkerställ att användaren är inloggad anonymt
function ensureAnonAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) await signInAnonymously(auth);
        resolve(auth.currentUser);
      } catch (e) {
        console.error("[hsb-bostad-logger] auth error", e);
        reject(e);
      }
    });
  });
}

// logga ett meddelande
async function logMessage({ role, text, meta = {} }) {
  await ensureAnonAuth();
  return addDoc(collection(db, COLLECTION), {
    sessionId: getSessionId(),
    role, // "user" | "assistant" | "system"
    text,
    meta: { source: "hsb_bostad", ...meta },
    createdAt: serverTimestamp(),
    userUid: auth.currentUser?.uid ?? null
  });
}

// globala krokar för chattfönstret
window.hsbLogUser = (text) => logMessage({ role: "user", text });
window.hsbLogAssistant = (text, meta) =>
  logMessage({ role: "assistant", text, meta });

console.log("[hsb-bostad-logger] init ok, projectId =", firebaseConfig.projectId);
