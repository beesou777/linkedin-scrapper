// Load environment variables from .env file
import * as dotenv from "dotenv";
dotenv.config();

import { LinkedinScraper, events } from "./src/index";

(async () => {

    console.log("Testing LinkedIn cookie...\n");

    const scraper = new LinkedinScraper({
        headless: true,
        slowMo: 100,
    });

    let cookieValid = false;

    scraper.on(events.scraper.invalidSession, () => {
        console.error("❌ Cookie is INVALID or EXPIRED!");
        console.log("\nPlease get a fresh cookie from LinkedIn:");
        console.log("1. Login to LinkedIn in your browser");
        console.log("2. Open DevTools (F12) → Application → Cookies → linkedin.com");
        console.log("3. Find 'li_at' cookie and copy its value");
        cookieValid = false;
    });

    scraper.on(events.scraper.error, (err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Error:", errorMessage);
    });

    scraper.on(events.scraper.data, () => {
        cookieValid = true;
        console.log("✓ Cookie is VALID! Scraper can access LinkedIn.");
    });

    try {
        await scraper.run({
            query: "test",
            options: {
                locations: ["Nepal"],
                limit: 1,
            }
        });
        
        if (cookieValid) {
            console.log("\n✅ Cookie validation successful!");
        }
    } catch (error) {
        console.error("Validation failed:", error);
    } finally {
        await scraper.close();
    }
})();

