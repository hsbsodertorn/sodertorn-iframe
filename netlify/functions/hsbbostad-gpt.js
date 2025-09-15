const fetch = require("node-fetch");

exports.handler = async function(event, context) {
  console.log("HSBBostad GPT-funktion anropad");

  try {
    const { messages } = JSON.parse(event.body);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`, // samma nyckel
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo", // byt modell här om du vill
        messages,
        temperature: 0.4
      })
    });

    const data = await response.json();
    console.log("Svar från OpenAI (HSBBostad):", data);

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Fel i hsbbostad-gpt.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Kunde inte hämta AI-svar från HSBBostad GPT" })
    };
  }
};
