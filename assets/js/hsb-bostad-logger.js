// assets/js/hsb-bostad-logger.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app-check.js";

// 🔑 firebase config för HSB Bostad GPT (ny app i projektet hsbsodertorn-1e7a5)
const firebaseConfig = {
  apiKey: "AIzaSyAmG3ZuxR8A6WNjPUwa3EDA79rLjwYqS_4",
  authDomain: "hsbsodertorn-1e7a5.firebaseapp.com",
  projectId: "hsbsodertorn-1e7a5",
  storageBucket: "hsbsodertorn-1e7a5.firebasestorage.app",
  messagingSenderId: "34372808211",
  appId: "1:34372808211:web:13a93841d95fe14cce59e6",
  measurementId: "G-3QJJK5PGQS"
};

// initiera appen
const app = initializeApp(firebaseConfig);

// 🛡️ app check (körs bara om du satt en riktig site key)
const APP_CHECK_SITE_KEY = "RECAPTCHA_V3_SITE_KEY"; // ersätt med din riktiga nyckel när du kör Enforce
try {
  if (APP_CHECK_SITE_KEY && !/^RECAPTCHA_/.test(APP_CHECK_SITE_KEY)) {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
    console.log("[hsb-bostad-logger] app check init (site key set)");
  } else {
    console.log("[hsb-bostad-logger] app check hoppar över init (ingen site key angiven)");
  }
} catch (e) {
  console.warn("[hsb-bostad-logger] app check init fel (ok om ej enforced)", e);
}

// firestore och auth
const db = getFirestore(app);
const auth = getAuth(app);

// 🔵 samling för bostadschatten
const COLLECTION = "chattlogg_bostad";

// sessions-id per flik (fallback om randomUUID saknas)
function getSessionId() {
  const k = "hsbBostad_sessionId";
  let id = sessionStorage.getItem(k);
  if (!id) {
    const rnd = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : ("sid_" + Math.random().toString(36).slice(2) + Date.now());
    sessionStorage.setItem(k, rnd);
    id = rnd;
  }
  return id;
}

// se till att vi är inloggade anonymt innan skrivning
function ensureAnonAuth() {
  return new Promise((resolve, reject) => {
    let settled = false;
    onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) await signInAnonymously(auth);
        if (!settled) {
          settled = true;
          resolve(auth.currentUser);
        }
      } catch (e) {
        if (!settled) {
          settled = true;
          console.error("[hsb-bostad-logger] auth error", e);
          reject(e);
        }
      }
    });
  });
}

// intern skriv-funktion med debug
async function writeDoc(payload) {
  await ensureAnonAuth();
  try {
    const ref = await addDoc(collection(db, COLLECTION), {
      ...payload,
      createdAt: serverTimestamp(),
      sessionId: getSessionId(),
      userUid: auth.currentUser?.uid ?? null
    });
    console.log("[hsb-bostad-logger] wrote doc", ref.id);
    return ref;
  } catch (e) {
    console.error("[hsb-bostad-logger] write failed", e);
    throw e;
  }
}

// logga ett meddelande
async function logMessage({ role, text, meta = {} }) {
  return writeDoc({
    role,                    // "user" | "assistant" | "system"
    text,
    meta: { source: "hsb_bostad", ...meta }
  });
}

// (valfritt) generisk eventlogg om du behöver annat än meddelanden
async function logEvent({ type, data = {}, meta = {} }) {
  return writeDoc({
    role: "event",
    text: type,
    data,
    meta: { source: "hsb_bostad", ...meta }
  });
}

// exponera krokar globalt för chattfönstret
window.hsbLogUser = (text) => logMessage({ role: "user", text });
window.hsbLogAssistant = (text, meta) => logMessage({ role: "assistant", text, meta });
window.hsbLogEvent = (type, data, meta) => logEvent({ type, data, meta });

console.log("[hsb-bostad-logger] init ok, projectId =", firebaseConfig.projectId);
