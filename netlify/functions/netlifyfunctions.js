const fetch = require("node-fetch");

exports.handler = async function(event, context) {
  console.log("Funktionen har anropats");

  // Läs in svaren från användaren
  const body = JSON.parse(event.body);
  const answers = body.answers || [];

  // Logga de mottagna svaren från användaren
  console.log("Mottagna svar:", answers);

  const prompt = `
    Du är en klimatrådgivare. Här är svaren från en bostadsrättsförening:
    ${answers.map((a, i) => `Fråga ${i + 1}: ${a}`).join("\n")}

    Ge en kort sammanfattning i tre delar:
    1. Risker föreningen står inför
    2. Rekommenderade åtgärder
    3. Tips på vad föreningen bör prioritera först.
  `;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "Du är expert på klimatanpassning av fastigheter." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7
      })
    });

    const data = await res.json();

    // Logga svaret från OpenAI för felsökning
    console.log("Svar från OpenAI:", data);

    return {
      statusCode: 200,
      body: JSON.stringify({ result: data.choices?.[0]?.message?.content || "Inget svar." })
    };
  } catch (err) {
    console.error("Fel i AI-funktionen:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Kunde inte hämta AI-svar" })
    };
  }
};
