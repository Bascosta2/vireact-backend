import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config({ path: "../../../.env" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function testOpenAI() {
  const response = await openai.chat.completions.create({
    model: process.env.AI_MODEL_STRUCTURED || 'gpt-6-luna',
    messages: [{ role: "user", content: "Hello, how are you?" }],
  });

  console.log(response.choices[0].message.content);

}

testOpenAI();