const fetch = require("node-fetch");
const admin = require("firebase-admin");

// initiera firebase endast om det inte redan är initierat
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  } catch (e) {
    console.warn("⚠️ kunde inte initiera firebase-admin:", e);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

exports.handler = async function(event, context) {
  console.log("📨 styrelsesupport GPT-funktion anropad");

  try {
    const { messages, conversationId } = JSON.parse(event.body);
    const lastUserMessage = messages[messages.length - 1]?.content || "";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        temperature: 0.4
      })
    });

    const data = await response.json();
    const gptSvar = data.choices?.[0]?.message?.content || "Inget svar från GPT";

    console.log("✅ GPT-svar:", gptSvar);

    // 🔒 försök spara i Firestore om det är tillgängligt
    if (db) {
      try {
        await db.collection("chattlogg").add({
          conversationId: conversationId || "okänd",
          fråga: lastUserMessage,
          svar: gptSvar,
          tid: new Date()
        });
        console.log("📝 sparat i Firestore");
      } catch (logError) {
        console.warn("⚠️ kunde inte logga till Firestore:", logError);
      }
    } else {
      console.warn("⚠️ Firestore saknas – loggning hoppades över");
    }

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {
    console.error("❌ Fel i styrelsesupportGPT.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Kunde inte hämta AI-svar" })
    };
  }
};
