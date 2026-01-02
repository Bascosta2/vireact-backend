// test-twelve-labs.js

import dotenv from "dotenv";
import { TwelveLabs } from 'twelvelabs-js';


dotenv.config({ path: "../../../.env" });

const TWELVE_LABS_API_KEY = process.env.TWELVE_LABS_API_KEY;

const client = new TwelveLabs({
    apiKey: TWELVE_LABS_API_KEY,
});

async function testTwelveLabs() {
    let assets = await client.assets.list();
    console.log("All Assets List", assets);

}

testTwelveLabs();