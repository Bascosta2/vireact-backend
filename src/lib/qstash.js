import { Client } from "@upstash/qstash";
import { QSTASH_TOKEN } from "../config/index.js";

// QStash client instance (lazy initialization)
let qstashClient = null;

// Get QStash client (lazy initialization)
export function getQStashClient() {
  if (!qstashClient) {
    if (!QSTASH_TOKEN) {
      throw new Error('QStash configuration missing: QSTASH_TOKEN is required');
    }
    
    qstashClient = new Client({
      token: QSTASH_TOKEN,
    });
  }
  return qstashClient;
}

