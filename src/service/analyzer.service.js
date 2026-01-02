import { KnowledgeBase } from "../model/knowledge-base.model.js"
import { TWELVE_LABS_API_KEY, KNOWLEDGE_BASE_VECTOR_INDEX } from "../config/index.js";
import { requestChatCompletion } from "./openai-response.service.js";

// export const analyzeVideoService = async (videoUrl) => {
//   try {
//     /* 
//     🧩 STEP 1: Get video input (from frontend upload or existing S3 URL)
//     -------------------------------------------------------------------
//     - The frontend tlk_2FXQCW52100K9N2K6GM662XFBZ65 a signed S3 URL of the uploaded video.
//     - At this stage, we assume the video is already stored and accessible.
//     - This service does not handle file uploads directly — it only consumes the video URL.
//     */
//     console.log("📹 Video URL received:", videoUrl);

//     const relevantChunks = await KnowledgeBase.aggregate([
//       {
//         $vectorSearch: {
//           index: KNOWLEDGE_BASE_VECTOR_INDEX,
//           queryVector: hookEmbedding,
//           path: "embedding",
//           filter: { "metadata.topic": "hook" },
//           limit: 8,
//         },
//       },
//     ]);

//     /* 
//     🧩 STEP 6: Build contextual prompt for the LLM
//     ----------------------------------------------
//     - Combine the retrieved chunks into a formatted prompt.
//     - Inject the real hook transcript from the uploaded video.
//     - The LLM will compare the new hook to Bas’s established hook principles.
//     */
//     const ragContext = relevantChunks
//       .map(
//         (c, i) =>
//           `${i + 1}. [${c.metadata.layer.toUpperCase()}] ${c.content}`
//       )
//       .join("\n");

//     const prompt = `
//   You are an expert psychological content reviewer trained on Bas’s mindset.
//   Here are Bas’s hook insights and examples:
//   ${ragContext}
  
//   Here is the video hook:
//   ""
  
//   Evaluate this hook as Weak, Medium, or Strong.
//   Explain your reasoning and suggest improvement.
//   `;

//     /* 
//     🤖 STEP 7: Send prompt to LLM (OpenAI / Claude / Gemini)
//     ---------------------------------------------------------
//     - The AI model uses the context to analyze and rate the video’s hook quality.
//     - The output is natural-language feedback containing reasoning and suggestions.
//     */
//     const feedback = await requestChatCompletion({
//       messages: [{ role: "user", content: prompt }],
//       temperature: 0.7,
//       maxTokens: 500,
//       systemPrompt:
//         "You are a concise hook reviewer. Provide clear, neutral analysis under 160 words in plain text.",
//     });

//     /* 
//     📦 STEP 8: Return structured insights
//     -------------------------------------
//     - Return all relevant analysis info in one object.
//     - Includes retrieved context count, AI feedback, and scene data for future modules.
//     - The frontend can display feedback visually (e.g. radar chart or text cards).
//     */
//     return {
//       feedback
//     };

//   } catch (error) {
//     /* 
//     ⚠️ STEP 9: Error Handling
//     -------------------------
//     - Catch and log any errors during the analysis pipeline.
//     - Errors could come from S3 URL issues, API rate limits, or vector search failure.
//     */
//     console.error("❌ Error in analyzeVideoService:", error.message);
//     throw error;
//   }
// };

