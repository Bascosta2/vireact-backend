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
      type: String,
      required: true,
      enum: ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor', 'general'],
      index: true,
    },
    layer: {
      type: String,
      enum: ['raw', 'pattern', 'example'],
      required: true,
      index: true,
    },
    author: {
      type: String,
      default: "Bas Costa",
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
    source: {
      type: String,
      default: "manual_note",
    },
    score: {
      type: Number,
      required: true,
      min: 0.1,
      max: 1,
    },
    platform: { type: String },
    /** Optional; not used for retrieval filtering — RAG uses vector similarity only */
    niche: { type: String },
    viralCategory: { type: String },
    creatorSize: { type: String },
    actualViews: { type: Number },
    creatorHandle: { type: String },
    sourceType: { type: String },
    contentType: { type: String },
    chunkIndex: { type: Number },
    totalChunks: { type: Number },
    ingestedAt: { type: Date },
  },
});

export const KnowledgeBase = mongoose.model("KnowledgeBase", KnowledgeBaseSchema);
