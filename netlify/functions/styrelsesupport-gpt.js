const fetch = require("node-fetch");
const admin = require("firebase-admin");

// initiera firebase om det inte redan är initierat
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

exports.handler = async function(event, context) {
  console.log("Styrelsesupport GPT-funktion anropad");

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

    // 🔒 spara i Firestore
    await db.collection("chattlogg").add({
      conversationId: conversationId || "okänd",
      fråga: lastUserMessage,
      svar: gptSvar,
      tid: new Date()
    });

    console.log("Svar från OpenAI:", gptSvar);

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Fel i styrelsesupportGPT.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Kunde inte hämta AI-svar" })
    };
  }
};
