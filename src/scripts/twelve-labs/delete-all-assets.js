// test-twelve-labs.js

import dotenv from "dotenv";
import { TwelveLabs } from 'twelvelabs-js';


dotenv.config({ path: "../../../.env" });

const TWELVE_LABS_API_KEY = process.env.TWELVE_LABS_API_KEY;

const client = new TwelveLabs({
    apiKey: TWELVE_LABS_API_KEY,
});

async function deleteAllAssets() {
    // 1️⃣ List first page of assets
    let assetsPage = await client.assets.list({
        page: 1,
        limitPerPage: 50,
    });

    // 2️⃣ Loop through pages
    while (true) {
        for (const asset of assetsPage.data) {
            await client.assets.delete(asset.id);

            console.log(`✅ Deleted asset ${asset.id}`);
        }

        // 3️⃣ Exit if no more pages
        if (!assetsPage.hasNextPage()) break;

        assetsPage = await assetsPage.loadNextPage();
    }

    console.log('🔥 All assets deleted successfully');

}

deleteAllAssets();