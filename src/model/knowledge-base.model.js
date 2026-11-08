import mongoose from "mongoose";
import { KB_SPECIFICITY, KB_EXEMPLAR_TYPES } from "../constants.js";

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
    /**
     * How usable this chunk is as an exemplar for a literal rewrite.
     * `vague` chunks are excluded from analyzer/chat retrieval so directional
     * prose can never be cited as the basis for a drop-in fix. `unrated` is the
     * default for chunks ingested before this tag existed — still retrievable.
     * Filtering happens in `analyzer/retrieve-knowledge.js` (in code, not in the
     * `$vectorSearch` filter, so no Atlas index change is required).
     */
    specificity: {
      type: String,
      enum: Object.values(KB_SPECIFICITY),
      default: KB_SPECIFICITY.UNRATED,
      index: true,
    },
    /** What kind of exemplar this chunk is, used for prompt labelling. */
    exemplarType: {
      type: String,
      enum: Object.values(KB_EXEMPLAR_TYPES),
      index: true,
      sparse: true,
    },
    /**
     * Feedback -> measured-outcome pairing, so `expectedImpact` can be grounded in
     * an observed number instead of an invented one. Populated from admin creator
     * ingest, where real performance data exists.
     */
    measuredImpact: {
      /** e.g. 'views', '3s_retention', 'completion_rate' */
      metric: { type: String },
      /** Signed percentage change attributed to the change described in `content`. */
      deltaPercent: { type: Number },
      /** Free-text note on how the delta was observed. */
      basis: { type: String },
    },
    /** Content category for exemplar retrieval (e.g. 'talking_head', 'tutorial'). */
    contentCategory: { type: String, index: true, sparse: true },
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
    /**
     * Autonomous research ingest (src/service/research-ingest). Only docs with origin "research"
     * may ever be removed by that pipeline; every other doc is left alone. Additive fields.
     */
    origin: { type: String },
    researchBatch: { type: String },
    researchId: { type: String },
    researchType: { type: String },
    sourceUrls: { type: [String], default: undefined },
    topics: { type: [String], default: undefined },
    platforms: { type: [String], default: undefined },
    niches: { type: [String], default: undefined },
    reviewScore: { type: Number },
  },
});

export const KnowledgeBase = mongoose.model("KnowledgeBase", KnowledgeBaseSchema);
