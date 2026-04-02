import { Client } from "@upstash/qstash";
import { QSTASH_TOKEN, QSTASH_URL } from "../config/index.js";

// QStash client instance (lazy initialization)
let qstashClient = null;

// Get QStash client (lazy initialization)
export function getQStashClient() {
  if (!qstashClient) {
    const token = process.env.QSTASH_TOKEN || QSTASH_TOKEN;
    const baseUrl = process.env.QSTASH_URL || QSTASH_URL;
    console.log('[QStash] Client initialized, token exists:', !!token);
    console.log('[QStash] Using URL:', baseUrl || '(SDK default)');
    if (!token) {
      throw new Error('QStash configuration missing: QSTASH_TOKEN is required');
    }

    qstashClient = new Client({
      token,
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  return qstashClient;
}
