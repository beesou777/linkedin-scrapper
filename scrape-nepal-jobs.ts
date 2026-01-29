// Load environment variables from .env file
import * as dotenv from "dotenv";
dotenv.config();

import {
    LinkedinScraper,
    events,
    timeFilter,
} from "./src/index";
import * as fs from "fs";
import { Client } from "pg";
import { env } from "process";

// Database helper functions
async function getExistingJobIds(client: Client): Promise<Set<string>> {
    try {
        const result = await client.query('SELECT job_id FROM linkedin_jobs');
        return new Set(result.rows.map(row => row.job_id));
    } catch (error) {
        console.log(`⚠ Could not load existing jobs from database: ${error}`);
        return new Set();
    }
}

async function insertJob(client: Client, job: any): Promise<boolean> {
    try {
        // Parse date if available
        let jobDate = null;
        if (job.date) {
            // Try to parse the date string
            const parsedDate = new Date(job.date);
            if (!isNaN(parsedDate.getTime())) {
                jobDate = parsedDate.toISOString().split('T')[0];
            }
        }

        const result = await client.query(
            `INSERT INTO linkedin_jobs 
            (job_id, title, company, company_link, place, job_date, job_link, apply_link, description, insights) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (job_id) DO NOTHING
            RETURNING job_id`,
            [
                job.jobId,
                job.title,
                job.company !== "N/A" ? job.company : null,
                job.companyLink !== "N/A" ? job.companyLink : null,
                job.place || null,
                jobDate,
                job.link || null,
                job.applyLink !== "N/A" ? job.applyLink : null,
                job.description || null,
                job.insights ? JSON.stringify(job.insights) : null
            ]
        );
        // If result has rows, it was inserted. If no rows, it was skipped (duplicate)
        return result.rows.length > 0;
    } catch (error: any) {
        // If it's a unique constraint violation, it's a duplicate - that's okay
        if (error.code === '23505') {
            return false; // Duplicate
        }
        console.error(`Error inserting job ${job.jobId}:`, error.message);
        return false;
    }
}

(async () => {
    // Single JSON file to store all jobs
    const JSON_FILE = "nepal-jobs.json";
    
    // Initialize database connection
    let dbClient: Client | null = null;
    const databaseUrl = env.DATABASE_URL;
    let dbJobIds = new Set<string>();
    
    if (databaseUrl) {
        try {
            dbClient = new Client({
                connectionString: databaseUrl,
                ssl: { rejectUnauthorized: false } // Required for Supabase
            });
            await dbClient.connect();
            console.log("✓ Connected to database\n");
            
            // Load existing job IDs from database
            dbJobIds = await getExistingJobIds(dbClient);
            console.log(`📊 Found ${dbJobIds.size} existing jobs in database\n`);
        } catch (error: any) {
            console.log(`⚠ Could not connect to database: ${error.message}`);
            console.log("Continuing without database...\n");
            dbClient = null;
        }
    } else {
        console.log("⚠ DATABASE_URL not set, skipping database operations\n");
    }
    
    // Load existing jobs from file if it exists
    let existingJobs: any[] = [];
    if (fs.existsSync(JSON_FILE)) {
        try {
            const fileContent = fs.readFileSync(JSON_FILE, "utf-8");
            existingJobs = JSON.parse(fileContent);
            console.log(`✓ Loaded ${existingJobs.length} existing jobs from ${JSON_FILE}\n`);
        } catch (error) {
            console.log(`⚠ Could not load existing jobs, starting fresh\n`);
            existingJobs = [];
        }
    }

    // Create a Set to track unique identifiers (applyLink, link, jobId)
    const existingIds = new Set<string>();
    existingJobs.forEach(job => {
        // Track by jobId, link, and applyLink (if not "N/A")
        if (job.jobId) existingIds.add(`id:${job.jobId}`);
        if (job.link) existingIds.add(`link:${job.link}`);
        if (job.applyLink && job.applyLink !== "N/A") {
            existingIds.add(`apply:${job.applyLink}`);
        }
    });
    
    // Also add database job IDs to the tracking set
    dbJobIds.forEach(jobId => {
        existingIds.add(`id:${jobId}`);
    });
    
    console.log(`📊 Tracking ${existingIds.size} unique job identifiers (file + database)\n`);

    // Initialize the scraper with slower speed to avoid rate limiting
    // slowMo adds delay between all puppeteer actions
    const scraper = new LinkedinScraper({
        headless: true,
        slowMo: 1500, // 2.5 seconds to avoid LinkedIn rate limiting (increase if still getting 429)
        args: [
            "--lang=en-US",
        ],
    });

    // Array to store new jobs from this run
    const newJobs: any[] = [];
    let duplicateCount = 0;

    // Listen for job data
    scraper.on(events.scraper.data, (data) => {
        const job = {
            jobId: data.jobId,
            title: data.title,
            company: data.company || "N/A",
            companyLink: data.companyLink || "N/A",
            place: data.place,
            date: data.date,
            link: data.link,
            applyLink: data.applyLink || "N/A",
            description: data.description,
            insights: data.insights,
            scrapedAt: new Date().toISOString(), // Track when job was scraped
        };
        
        // Check for duplicates
        const isDuplicate = 
            (job.jobId && existingIds.has(`id:${job.jobId}`)) ||
            (job.link && existingIds.has(`link:${job.link}`)) ||
            (job.applyLink && job.applyLink !== "N/A" && existingIds.has(`apply:${job.applyLink}`));
        
        if (isDuplicate) {
            duplicateCount++;
            console.log(`⏭️  Duplicate skipped: ${job.title} at ${job.company}`);
            return; // Skip this job
        }
        
        // Add to tracking sets and new jobs
        if (job.jobId) existingIds.add(`id:${job.jobId}`);
        if (job.link) existingIds.add(`link:${job.link}`);
        if (job.applyLink && job.applyLink !== "N/A") {
            existingIds.add(`apply:${job.applyLink}`);
        }
        
        newJobs.push(job);
        
        console.log("\n=== New Job Added ===");
        console.log(`Title: ${job.title}`);
        console.log(`Company: ${job.company}`);
        console.log(`Location: ${job.place}`);
        console.log(`Date: ${job.date}`);
        console.log(`Link: ${job.link}`);
        console.log("====================\n");
    });

    // Listen for metrics (progress updates)
    scraper.on(events.scraper.metrics, (metrics) => {
        console.log(`Progress: Processed=${metrics.processed}, Failed=${metrics.failed}, Missed=${metrics.missed}`);
    });

    // Listen for errors
    scraper.on(events.scraper.error, (err) => {
        console.error("Error occurred:", err);
    });

    // // Listen for invalid session
    // scraper.on(events.scraper.invalidSession, () => {
    //     console.error("Invalid session! Please check your LI_AT_COOKIE",env.LI_AT_COOKIE);
    // });

    // Listen for end event
    scraper.on(events.scraper.end, async () => {
        console.log(`\n📊 Scraping Summary:`);
        console.log(`   New jobs found: ${newJobs.length}`);
        console.log(`   Duplicates skipped: ${duplicateCount}`);
        
        // Upload to database if connected
        let dbInserted = 0;
        let dbSkipped = 0;
        
        if (dbClient && newJobs.length > 0) {
            console.log(`\n📤 Uploading ${newJobs.length} new jobs to database...`);
            for (const job of newJobs) {
                const inserted = await insertJob(dbClient, job);
                if (inserted) {
                    dbInserted++;
                } else {
                    dbSkipped++;
                }
            }
            console.log(`✓ Database upload complete: ${dbInserted} inserted, ${dbSkipped} skipped (duplicates)`);
        }
        
        // Merge existing and new jobs
        const allJobs = [...existingJobs, ...newJobs];
        console.log(`   Total jobs in file: ${allJobs.length}`);
        
        // Save all jobs to single JSON file
        fs.writeFileSync(JSON_FILE, JSON.stringify(allJobs, null, 2));
        console.log(`✓ All jobs saved to ${JSON_FILE}`);
        
        // Close database connection
        if (dbClient) {
            await dbClient.end();
            console.log("✓ Database connection closed");
        }
    });

    console.log("Starting to scrape LinkedIn jobs from Nepal (within last 7 days)...\n");
    
    // if (env.LI_AT_COOKIE) {
    //     console.log("✓ Using authenticated session\n");
    // } else {
    //     console.log("⚠ Using anonymous session (may not work reliably)");
    //     console.log("Set LI_AT_COOKIE environment variable for better results\n");
    // }
    
    // Scrape ALL jobs - set very high limit (LinkedIn typically shows max 1000 results per search)
    // The scraper will stop automatically when no more jobs are available
    // Can be overridden with MAX_JOBS environment variable
    const MAX_JOBS_TO_SCRAPE = 500;
    
    console.log(`🎯 Target: Scrape up to ${MAX_JOBS_TO_SCRAPE} jobs (will stop when no more available)\n`);
    console.log("⏱️  Speed: 2.5s delay between actions to avoid LinkedIn rate limiting\n");
    console.log("📊 Estimated time:");
    console.log(`   - 100 jobs: ~10-15 minutes`);
    console.log(`   - 500 jobs: ~50-75 minutes`);
    console.log(`   - 1000 jobs: ~100-150 minutes\n`);
    console.log("💡 Tip: The scraper automatically stops when no more jobs are found\n");
    
    // Run the scraper with Nepal as location and filter for jobs posted within last 7 days
    await scraper.run({
        query: "",
        options: {
            locations: ["Nepal"],
            limit: MAX_JOBS_TO_SCRAPE, // High limit to get all jobs
            filters: {
                time: timeFilter.DAY, // Jobs posted within last 7 days
            }
        }
    }, {
        locations: ["Nepal"],
        limit: MAX_JOBS_TO_SCRAPE,
    });

    // Close browser
    await scraper.close();
})();

