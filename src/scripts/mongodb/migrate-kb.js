import mongoose from "mongoose";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";

// ---- UPDATE THESE ----
const SOURCE_MONGO_URI = "";       // your cluster
const DEST_MONGO_URI = "";         // Bas's cluster
// ----------------------

// Optional: Same schema for both sides
const knowledgeBaseSchema = new mongoose.Schema({}, { strict: false });

// const SourceKB = mongoose.model("KnowledgeBase", KnowledgeBase, "knowledgebases");
// const DestKB = mongoose.model("KnowledgeBase", KnowledgeBase);

async function migrate() {
  try {
    console.log("Connecting to source...");
    const sourceConn = await mongoose.createConnection(SOURCE_MONGO_URI).asPromise();

    console.log("Connecting to destination...");
    const destConn = await mongoose.createConnection(DEST_MONGO_URI).asPromise();

    const Source = sourceConn.model("KnowledgeBase", knowledgeBaseSchema, "knowledgebases");
    const Dest = destConn.model("KnowledgeBase", knowledgeBaseSchema, "knowledgebases");

    console.log("Fetching documents...");
    const docs = await Source.find().lean();
    console.log(`Fetched ${docs.length} docs.`);

    if (docs.length === 0) {
      console.log("Nothing to migrate.");
      process.exit(0);
    }

    console.log("Inserting into destination...");
    await Dest.insertMany(docs, { ordered: false });

    console.log("Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
