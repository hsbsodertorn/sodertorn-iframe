// assets/js/hsb-bostad-logger.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// fyll i ditt riktiga config — se till att projectId är projektet du vill logga i (t.ex. "hsbsodertorn")
const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  projectId: "hsbsodertorn",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const COLLECTION = "chattlogg_bostad";

function getSessionId() {
  const k = "hsbBostad_sessionId";
  let id = sessionStorage.getItem(k);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
  return id;
}

function ensureAnonAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      try { if (!user) await signInAnonymously(auth); resolve(auth.currentUser); }
      catch (e) { console.error("auth error", e); reject(e); }
    });
  });
}

async function logMessage({ role, text, meta = {} }) {
  await ensureAnonAuth();
  return addDoc(collection(db, COLLECTION), {
    sessionId: getSessionId(),
    role,                     // "user" | "assistant" | "system"
    text,
    meta: { source: "hsb_bostad", ...meta },
    createdAt: serverTimestamp(),
    userUid: auth.currentUser?.uid ?? null
  });
}

// globala krokar för din chatt
window.hsbLogUser = (text) => logMessage({ role: "user", text });
window.hsbLogAssistant = (text, meta) => logMessage({ role: "assistant", text, meta });

console.log("[hsb-bostad-logger] init ok");
