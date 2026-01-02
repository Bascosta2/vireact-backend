import mongoose from "mongoose";

const KnowledgeBaseSchema = new mongoose.Schema({
  content: {
    type: String, // The actual chunk of Bas’s insight
    required: true,
  },
  embedding: {
    type: [Number], // Vector embedding (float array)
    required: true,
    index: "vector", // Atlas Vector Index will use this
  },
  metadata: {
    topic: {
      type: String, // hook | caption | pacing | audio | advanced_analytics | views_predictor
      required: true,
      enum: ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor'],
      index: true,
    },
    layer: {
      type: String, // raw | pattern | example
      enum: ['raw', 'pattern', 'example'],
      required: true,
      index: true,
    },
    author: {
      type: String, // Usually "Bas", but flexible for future contributors
      default: "Bas Costa",
    },
    date: {
      type: Date, // Date of content/insight creation
      default: Date.now,
      index: true,
    },
    source: {
      type: String, // transcript | breakdown | manual_note | trend_scrape
      default: "manual_note",
    },
    score: {
      type: Number, // Optional score (0–1) for ranking certainty
      required: true,
      min: 0.1,
      max: 1,
    },
  },
});

export const KnowledgeBase = mongoose.model("KnowledgeBase", KnowledgeBaseSchema);
