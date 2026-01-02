import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import OpenAI from "openai";
import dotenv from "dotenv";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";

dotenv.config({ path: "../../../.env" });

const { DB_URL } = process.env;
const { OPENAI_API_KEY } = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From server/src/scripts/mongodb -> up to server -> data/pacing/pacing.json
const PACING_PATH = path.resolve(__dirname, "../../../data/pacing/pacing.json");

const MODEL_NAME = "text-embedding-3-large";
const MIN_SCORE = 0.1;
const DEFAULT_SOURCE = "manual_note";
const DEFAULT_AUTHOR = "Bas Costa";

const parseLimit = (argv) => {
    const value = Number(argv?.[2]);
    if (Number.isNaN(value) || value <= 0) {
        return null; // null means use all available
    }
    return value;
};

const isNonEmpty = (value) =>
    typeof value === "string" && value.trim().length > 0;

const coerceScore = (value) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= MIN_SCORE && num <= 1) return num;
    return MIN_SCORE;
};

const buildDocsFromEntry = (entry) => {
    const score = coerceScore(entry["importance"]);
    const layers = [
        { key: "raw", layer: "raw" },
        { key: "pattern", layer: "pattern" },
        { key: "example", layer: "example" },
    ];

    return layers
        .map(({ key, layer }) => {
            const content = entry[key];
            if (!isNonEmpty(content)) return null;
            return {
                content: content.trim(),
                metadata: {
                    topic: "pacing",
                    layer,
                    author: DEFAULT_AUTHOR,
                    source: DEFAULT_SOURCE,
                    score,
                },
            };
        })
        .filter(Boolean);
};

const getEmbedding = async (text) => {
    const response = await openai.embeddings.create({
        model: MODEL_NAME,
        input: text,
        encoding_format: "float",
    });
    const embedding = response?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("Empty embedding returned");
    }
    return embedding;
};

const seedPacing = async () => {
    if (!DB_URL) {
        console.error("Missing DB_URL in environment");
        process.exit(1);
    }

    const limit = parseLimit(process.argv);
    console.log(`Seed limit: ${limit ?? "ALL"}`);

    await mongoose.connect(DB_URL);

    try {
        const raw = await fs.readFile(PACING_PATH, "utf-8");
        const pacing = JSON.parse(raw);

        const limitedPacing = Array.isArray(pacing)
            ? pacing.slice(0, limit ?? pacing.length)
            : [];

        if (!limitedPacing.length) {
            console.warn("No pacing entries to seed");
            return;
        }

        const candidates = [];
        for (const entry of limitedPacing) {
            candidates.push(...buildDocsFromEntry(entry));
        }

        const docs = [];
        let embeddingFailures = 0;

        for (const doc of candidates) {
            try {
                const embedding = await getEmbedding(doc.content);
                docs.push({
                    ...doc,
                    embedding,
                });
            } catch (err) {
                embeddingFailures += 1;
                console.error(`Embedding failed for content snippet "${doc.content.slice(0, 40)}..."`, err.message);
            }
        }

        if (!docs.length) {
            console.warn("No documents ready to insert after embedding generation");
            return;
        }

        const inserted = await KnowledgeBase.insertMany(docs, { ordered: false });
        console.log(`Inserted: ${inserted.length}`);
        console.log(`Embedding failures: ${embeddingFailures}`);
        console.log(`Skipped (empty content or invalid): ${candidates.length - docs.length}`);
    } catch (err) {
        console.error("Seed failed:", err);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close();
    }
};

seedPacing().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});

