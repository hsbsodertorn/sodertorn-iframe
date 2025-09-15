const fetch = require("node-fetch");

const SYS_PROMPT = "du är hsb bostads kundsupport. skriv sakligt och omtänksamt. använd aldrig versaler på enstaka ord eller hela meningar. börja bara nya meningar med versal. skriv 'brf' och 'brf:er' med gemener. använd exempel från huddinge, botkyrka, tullinge, nynäshamn, visby och hemse där det passar. inga emojis.";

exports.handler = async function (event, context) {
  console.log("HSBBostad GPT-funktion anropad");

  try {
    const body = JSON.parse(event.body || "{}");
    const clientMessages = Array.isArray(body.messages) ? body.messages : [];

    // bygg safe messages: alltid systemprompt först, ignorera system från klient
    const safeMessages = [{ role: "system", content: SYS_PROMPT }];
    for (const m of clientMessages) {
      if (!m || m.role === "system") continue;
      safeMessages.push({ role: m.role, content: m.content });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY_STYRELSESUPPORTGPT}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: safeMessages,
        temperature: 0.3 // lite lägre temp = mindre risk för utsvävningar
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI API fel:", text);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "fel från OpenAI", details: text })
      };
    }

    const data = await response.json();
    console.log("Svar från OpenAI (HSBBostad):", JSON.stringify(data));

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Fel i hsbbostad-gpt.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "kunde inte hämta AI-svar från HSBBostad GPT" })
    };
  }
};
