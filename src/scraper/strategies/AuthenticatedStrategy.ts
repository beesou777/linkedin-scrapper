import { config } from "../../config";
import { RunStrategy, IRunStrategyResult, ILoadResult } from "./RunStrategy";
import { Browser, Page, CDPSession } from "puppeteer";
import { events, IMetrics } from "../events";
import { sleep } from "../../utils/utils";
import { normalizeString } from "../../utils/string";
import { IQuery } from "../query";
import { logger } from "../../logger/logger";
import debug from "debug";

export const selectors = {
    container: '.scaffold-layout__list',
    chatPanel: '.msg-overlay-list-bubble',
    jobs: 'div.job-card-container[data-job-id]', // More specific - must have data-job-id
    jobsList: '.scaffold-layout__list ul', // UL container (class is hashed, so use descendant selector)
    link: 'a.job-card-container__link',
    applyBtn: 'button.jobs-apply-button[role="link"]',
    title: '.artdeco-entity-lockup__title',
    company: '.artdeco-entity-lockup__subtitle',
    companyLink: '.job-details-jobs-unified-top-card__company-name a',
    place: '.artdeco-entity-lockup__caption',
    date: 'time',
    dateText: '.job-details-jobs-unified-top-card__primary-description-container span:nth-of-type(3)',
    description: '.jobs-description',
    detailsPanel: '.jobs-search__job-details--container',
    detailsTop: '.jobs-details-top-card',
    details: '.jobs-details__main-content',
    insights: '.job-details-jobs-unified-top-card__container--two-pane li',
    pagination: '.jobs-search-two-pane__pagination',
    privacyAcceptBtn: 'button.artdeco-global-alert__action',
    paginationNextBtn: 'li[data-test-pagination-page-btn].selected + li',
    paginationBtn: (index: number) => `li[data-test-pagination-page-btn="${index}"] button`,
    requiredSkills: '.job-details-how-you-match__skills-item-subtitle',
};

/**
 * @class AuthenticatedStrategy
 * @extends RunStrategy
 */
export class AuthenticatedStrategy extends RunStrategy {
    /**
     * Check if session is authenticated
     * @param {Page} page
     * @returns {Promise<boolean>}
     * @returns {Promise<ILoadResult>}
     * @static
     * @private
     */
    private static _isAuthenticatedSession = async (page: Page): Promise<boolean> => {
        if (/\/(login|checkpoint|uas|authwall)(\/|\?|$)/i.test(new URL(page.url()).pathname)) {
            return false;
        }
        if (await page.$('input[name="session_key"], input[name="session_password"], #captcha-internal')) {
            return false;
        }
        const cookies = await page.cookies();
        return cookies.some(e => e.name === "li_at");
    };

    /**
     * Load jobs
     * @param page {Page}
     * @param jobsTot {number}
     * @param timeout {number}
     * @static
     * @private
     */
    private static _loadJobs = async (
        page: Page,
        jobsTot: number,
        timeout: number = 2000,
    ): Promise<any> => {
        const pollingTime = 50;
        let elapsed = 0;

        await sleep(pollingTime);

        try {
            while (elapsed < timeout) {
                const jobsCount = await page.evaluate((selector) => {
                    return document.querySelectorAll(selector).length;
                }, selectors.jobs);

                if (jobsCount > jobsTot) {
                    return { success: true, count: jobsCount };
                }

                await sleep(pollingTime);
                elapsed += pollingTime;
            }
        }
        catch (err) {}

        return {
            success: false,
            error: `Timeout on loading jobs`
        };
    };

    /**
     * Try to load job details
     * @param {Page} page
     * @param {string} jobId
     * @param {number} timeout
     * @static
     * @private
     */
    private static _loadJobDetails = async (
        page: Page,
        jobId: string,
        timeout: number = 2000,
    ): Promise<ILoadResult> => {
        const pollingTime = 50;
        let elapsed = 0;
        let loaded = false;

        await sleep(pollingTime);

        try {
            while (elapsed < timeout) {
                loaded = await page.evaluate(
                    (jobId, panelSelector, descriptionSelector) => {
                        const detailsPanel = document.querySelector(panelSelector) as HTMLElement;
                        const description = document.querySelector(descriptionSelector) as HTMLElement;
                        return detailsPanel && detailsPanel.innerHTML.includes(jobId) &&
                            description && description.innerText.length > 0;
                    },
                    jobId,
                    selectors.detailsPanel,
                    selectors.description,
                );

                if (loaded) {
                    return { success: true };
                }

                await sleep(pollingTime);
                elapsed += pollingTime;
            }
        }
        catch (err) {}

        return {
            success: false,
            error: `Timeout on loading job details`
        };
    };

    /**
     * Try to paginate
     * @param {Page} page
     * @param {string} tag
     * @param {string} paginationSize
     * @param {number} timeout
     * @returns {Promise<ILoadResult>}
     * @static
     * @private
     */
    private static _paginate = async (
        page: Page,
        tag: string,
        paginationSize: number = 25,
        timeout: number = 2000,
    ): Promise<ILoadResult> => {
        const url = new URL(page.url());

        // Extract offset from url
        let offset = parseInt(url.searchParams.get('start') || "0", 10);
        offset += paginationSize;

        // Update offset in url
        url.searchParams.set('start', '' + offset);

        logger.info(tag, 'Next offset: ', offset);
        logger.info(tag, 'Opening', url.toString());

        // Navigate new url
        try {
            await page.goto(url.toString(), {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        } catch (err: any) {
            if (err.message && err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
                logger.error(tag, "Too many redirects during pagination. The cookie may be invalid or expired.");
                return {
                    success: false,
                    error: `Too many redirects during pagination`
                };
            }
            throw err;
        }

        const pollingTime = 100;
        let elapsed = 0;
        let loaded = false;

        logger.info(tag, 'Waiting for new jobs to load');

        // Wait for new jobs to load
        while (!loaded) {
            loaded = await page.evaluate(
                (selector) => {
                    return document.querySelectorAll(selector).length > 0;
                },
                selectors.jobs,
            );

            if (loaded) return { success: true };

            await sleep(pollingTime);
            elapsed += pollingTime;

            if (elapsed >= timeout) {
                return {
                    success: false,
                    error: `Timeout on pagination`
                };
            }
        }

        return { success: true };
    };

    /**
     * Hide chat panel
     * @param {Page} page
     * @param {string} tag
     */
    private static _hideChatPanel = async (
        page: Page,
        tag: string,
    ): Promise<void> => {
        try {
            await page.evaluate((selector) => {
                    const div = document.querySelector(selector) as HTMLElement;
                    if (div) {
                        div.style.display = "none";
                    }
                },
                selectors.chatPanel);
        }
        catch (err) {
            logger.debug(tag, "Failed to hide chat panel");
        }
    };

    /**
     * Accept cookies
     * @param {Page} page
     * @param {string} tag
     */
    private static _acceptCookies = async (
        page: Page,
        tag: string,
    ): Promise<void> => {
        try {
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const cookieButton = buttons.find(e => e.innerText.includes('Accept cookies'));

                if (cookieButton) {
                    cookieButton.click();
                }
            });
        }
        catch (err) {
            logger.debug(tag, "Failed to accept cookies");
        }
    };

    /**
     * Accept privacy
     * @param page
     * @param tag
     */
    private static _acceptPrivacy = async (
        page: Page,
        tag: string,
    ): Promise<void> => {
        try {
            await page.evaluate((selector) => {
                const privacyButton = Array.from(document.querySelectorAll<HTMLElement>(selector))
                    .find(e => e.innerText === 'Accept');

                if (privacyButton) {
                    privacyButton.click();
                }
            }, selectors.privacyAcceptBtn);
        }
        catch (err) {
            logger.debug(tag, "Failed to accept privacy");
        }
    };

    /**
     * Try extracting apply link
     * @param {Page} page
     * @param {CDPSession} cdpSession
     * @param {string} tag
     * @param {number} timeout
     * @returns {Promise<{ success: boolean, url?: string, error?: string | Error }>}
     */
    private static _extractApplyLink = async (
        page: Page,
        cdpSession: CDPSession,
        tag: string,
        timeout = 4,
    ): Promise<{ success: boolean, url?: string, error?: string | Error }> => {
        try {
            logger.debug(tag, 'Try extracting apply link');
            const currentUrl = page.url();
            const elapsed = 0;
            const sleepTimeMs = 100;

            if (await page.evaluate((applyBtnSelector: string) => {
                const applyBtn = document.querySelector(applyBtnSelector) as HTMLButtonElement;

                if (applyBtn) {
                    applyBtn.click();
                    return true;
                }

                return false;
            }, selectors.applyBtn)) {

                while (elapsed < timeout) {
                    const targetsResponse = await cdpSession.send('Target.getTargets');

                    // The first target of type page with a valid url different from main page should be our guy
                    if (targetsResponse.targetInfos && targetsResponse.targetInfos.length > 1) {
                        for (const targetInfo of targetsResponse.targetInfos) {
                            if (targetInfo.attached && targetInfo.type === 'page' && targetInfo.url && targetInfo.url !== currentUrl) {
                                await cdpSession.send('Target.closeTarget', { targetId: targetInfo.targetId });
                                return { success: true, url: targetInfo.url };
                            }
                        }
                    }

                    await sleep(sleepTimeMs);
                }

                return { success: false, error: 'timeout' };
            }
            else {
                return { success: false, error: 'apply button not found' };
            }
        }
        catch (err: any) {
            logger.warn(tag, 'Failed to extract apply link', err);
            return { success: false, error: err };
        }
    };

    /**
     * Run strategy
     * @param browser
     * @param page
     * @param cdpSession
     * @param url
     * @param query
     * @param location
     */
    public run = async (
        browser: Browser,
        page: Page,
        cdpSession: CDPSession,
        url: string,
        query: IQuery,
        location: string,
    ): Promise<IRunStrategyResult> => {
        let tag = `[${query.query}][${location}]`;

        const metrics: IMetrics = {
            processed: 0,
            failed: 0,
            missed: 0,
            skipped: 0,
        };

        let paginationIndex = query.options?.pageOffset || 0;
        let paginationSize = 25;

        // Set cookie from configuration / environment
        if (!config.LI_AT_COOKIE) {
            logger.error("LI_AT_COOKIE is not set. Please define it in your environment or .env file.");
            this.scraper.emit(events.scraper.invalidSession);
            return { exit: true };
        }

        logger.info("Setting authentication cookie from LI_AT_COOKIE");
        await page.setCookie({
            name: "li_at",
            value: config.LI_AT_COOKIE.trim(),
            domain: ".linkedin.com",
            path: "/",
            secure: true,
            sameSite: "None",
        });

        // Override start by the page offset
        const _url = new URL(url);
        _url.searchParams.set('start', `${paginationIndex * paginationSize}`);
        url = _url.href;

        // Open search url
        logger.info(tag, "Opening", url);

        try {
            const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            if (response && [401, 403].includes(response.status())) {
                logger.error(tag, 'LinkedIn rejected the search request. Sign in manually, complete any verification, and update LI_AT_COOKIE.');
                this.scraper.emit(events.scraper.invalidSession);
                return { exit: true };
            }
        } catch (err: any) {
            if (err.message && err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
                logger.error(tag, 'LinkedIn entered a redirect loop. Sign in manually, complete any verification, and update LI_AT_COOKIE before rerunning.');
                this.scraper.emit(events.scraper.invalidSession);
                return { exit: true };
            } else {
                throw err;
            }
        }

        // Verify session
        if (!(await AuthenticatedStrategy._isAuthenticatedSession(page))) {
            logger.error("The provided session cookie is invalid. Check the documentation on how to obtain a valid session cookie.");
            this.scraper.emit(events.scraper.invalidSession);
            return { exit: true };
        }

        // Wait for page to fully load and handle any modals/cookies
        await AuthenticatedStrategy._hideChatPanel(page, tag);
        await AuthenticatedStrategy._acceptCookies(page, tag);
        await AuthenticatedStrategy._acceptPrivacy(page, tag);

        // Wait a bit for the page to settle
        await sleep(2000);

        // Try to wait for jobs container or job cards with multiple fallbacks
        let jobsFound = false;
        const selectorsToTry = [
            selectors.container,
            selectors.jobs,
            'ul.scaffold-layout__list-container',
            '.jobs-search-results-list',
            '.jobs-search__results-list',
        ];

        for (const selector of selectorsToTry) {
            try {
                await page.waitForSelector(selector, { timeout: 10000 });
                logger.debug(tag, `Found container with selector: ${selector}`);
                
                // Check if there are actual job cards
                const jobCount = await page.evaluate((jobSelector) => {
                    return document.querySelectorAll(jobSelector).length;
                }, selectors.jobs);

                if (jobCount > 0) {
                    logger.info(tag, `Found ${jobCount} job cards on the page`);
                    jobsFound = true;
                    break;
                } else {
                    // Try scrolling to trigger lazy loading
                    await page.evaluate(() => {
                        window.scrollTo(0, document.body.scrollHeight / 2);
                    });
                    await sleep(1000);
                    
                    const jobCountAfterScroll = await page.evaluate((jobSelector) => {
                        return document.querySelectorAll(jobSelector).length;
                    }, selectors.jobs);

                    if (jobCountAfterScroll > 0) {
                        logger.info(tag, `Found ${jobCountAfterScroll} job cards after scrolling`);
                        jobsFound = true;
                        break;
                    }
                }
            } catch (err) {
                // Try next selector
                continue;
            }
        }

        if (!jobsFound) {
            // Last attempt: check for any job-related elements
            const anyJobs = await page.evaluate(() => {
                const jobSelectors = [
                    'div.job-card-container',
                    'li.jobs-search-results__list-item',
                    'div[data-job-id]',
                    'a.job-card-container__link',
                ];
                
                for (const selector of jobSelectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        return elements.length;
                    }
                }
                return 0;
            });

            if (anyJobs === 0) {
                logger.warn(tag, `No jobs found after checking multiple selectors. Page URL: ${page.url()}`);
                logger.debug(tag, `Page title: ${await page.title()}`);
                return { exit: false };
            } else {
                logger.info(tag, `Found ${anyJobs} jobs using fallback detection`);
                jobsFound = true;
            }
        }

        // Scroll to top to ensure we start from the beginning
        await page.evaluate(() => {
            window.scrollTo(0, 0);
        });
        await sleep(500);

        // Pagination loop
        while (metrics.processed < query.options!.limit!) {
            // Verify session in the loop
            if (!(await AuthenticatedStrategy._isAuthenticatedSession(page))) {
                logger.warn(tag, "Session is invalid, this may cause the scraper to fail.");
                this.scraper.emit(events.scraper.invalidSession);
            }
            else {
                logger.info(tag, "Session is valid");
            }

            await AuthenticatedStrategy._hideChatPanel(page, tag);
            await AuthenticatedStrategy._acceptCookies(page, tag);
            await AuthenticatedStrategy._acceptPrivacy(page, tag);

            let jobIndex = 0;

            // Get number of all job links in the page - try multiple selectors
            let jobsTot = await page.evaluate((jobSelector) => {
                return document.querySelectorAll(jobSelector).length;
            }, selectors.jobs);

            // If no jobs found with primary selector, try fallback selectors
            if (jobsTot === 0) {
                logger.debug(tag, `No jobs found with primary selector, trying fallbacks...`);
                jobsTot = await page.evaluate(() => {
                    const selectors = [
                        'div.job-card-container',
                        'li.jobs-search-results__list-item',
                        'div[data-job-id]',
                        'a.job-card-container__link',
                        '.job-card-list__entity-lockup',
                    ];
                    
                    for (const selector of selectors) {
                        const elements = document.querySelectorAll(selector);
                        if (elements.length > 0) {
                            return elements.length;
                        }
                    }
                    return 0;
                });
            }

            logger.info(tag, `Found ${jobsTot} jobs to process`);

            if (jobsTot === 0) {
                logger.info(tag, `No jobs found, skip`);
                break;
            }

            // Jobs loop
            while (jobIndex < jobsTot && metrics.processed < query.options!.limit!) {
                tag = `[${query.query}][${location}][${paginationIndex * paginationSize + jobIndex + 1}]`;

                let jobId;
                let jobLink;
                let jobApplyLink;
                let jobTitle;
                let jobCompany;
                let jobCompanyLink;
                let jobCompanyImgLink;
                let jobPlace;
                let jobDescription;
                let jobDescriptionHTML;
                let jobDate;
                let jobDateText;
                let loadDetailsResult;
                let jobInsights;
                let jobSkills;
                let jobIsPromoted = false;

                try {
                    // Extract job main fields
                    logger.debug(tag, `Processing job ${jobIndex + 1} of ${jobsTot}`);

                    // Wait a bit before extracting to ensure page is stable
                    await sleep(200);

                    const jobFieldsResult = await page.evaluate(
                        (
                            jobsSelector: string,
                            linkSelector: string,
                            titleSelector: string,
                            companySelector: string,
                            placeSelector: string,
                            dateSelector: string,
                            jobIndex: number
                        ) => {
                            const jobs = document.querySelectorAll(jobsSelector);
                            
                            if (jobIndex >= jobs.length) {
                                throw new Error(`Job index ${jobIndex} out of range. Found ${jobs.length} jobs.`);
                            }

                            const job = jobs[jobIndex];
                            if (!job) {
                                throw new Error(`Job at index ${jobIndex} is null`);
                            }

                            const link = job.querySelector(linkSelector) as HTMLElement;
                            if (!link) {
                                throw new Error(`Link not found for job at index ${jobIndex}`);
                            }

                            // Scroll into view (click will happen outside evaluate)
                            link.scrollIntoView({ behavior: 'smooth', block: 'center' });

                            // Extract job link (relative)
                            const protocol = window.location.protocol + "//";
                            const hostname = window.location.hostname;
                            const jobLink = protocol + hostname + link.getAttribute("href");

                            const jobId = job.getAttribute("data-job-id");

                            let title = job.querySelector(titleSelector) ?
                                (<HTMLElement>job.querySelector(titleSelector)).innerText : "";

                            if (title.includes('\n')) {
                                title = title.split('\n')[1];
                            }

                            let company = "";

                            if (job.querySelector(companySelector)) {
                                let companyElem = job.querySelector<HTMLElement>(companySelector)!;
                                company = companyElem.innerText;
                            }

                            const companyImgLink = (<HTMLElement>job.querySelector("img"))?.getAttribute("src") ?? undefined;

                            const place = job.querySelector(placeSelector) ?
                                (<HTMLElement>job.querySelector(placeSelector)).innerText : "";

                            const date = job.querySelector(dateSelector) ?
                                (<HTMLElement>job.querySelector(dateSelector)).getAttribute('datetime') : "";

                            const isPromoted = !!(Array.from(job.querySelectorAll('li'))
                                .find(e => e.innerText === 'Promoted'));

                            return {
                                jobId,
                                jobLink,
                                title,
                                company,
                                companyImgLink,
                                place,
                                date,
                                isPromoted,
                            };
                        },
                        selectors.jobs,
                        selectors.link,
                        selectors.title,
                        selectors.company,
                        selectors.place,
                        selectors.date,
                        jobIndex
                    );

                    jobId = jobFieldsResult.jobId;
                    jobLink = jobFieldsResult.jobLink;
                    jobTitle = jobFieldsResult.title;
                    jobCompany = jobFieldsResult.company;
                    jobCompanyImgLink = jobFieldsResult.companyImgLink;
                    jobPlace = jobFieldsResult.place;
                    jobDate = jobFieldsResult.date;
                    jobIsPromoted = jobFieldsResult.isPromoted;

                    // Click the job link to load details (if not already clicked in evaluate)
                    try {
                        await page.evaluate((jobsSelector, linkSelector, jobIndex) => {
                            const jobs = document.querySelectorAll(jobsSelector);
                            if (jobIndex < jobs.length) {
                                const job = jobs[jobIndex];
                                const link = job.querySelector(linkSelector) as HTMLElement;
                                if (link) {
                                    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    link.click();
                                }
                            }
                        }, selectors.jobs, selectors.link, jobIndex);
                        
                        // Wait for job details panel to load
                        await sleep(1000);
                    } catch (clickErr: any) {
                        logger.warn(tag, `Failed to click job link: ${clickErr.message}`);
                    }

                    // Promoted job
                    if (query.options?.skipPromotedJobs && jobIsPromoted) {
                        logger.info(tag, 'Skipped because promoted');
                        metrics.skipped += 1;
                        jobIndex += 1;

                        if (metrics.processed < query.options!.limit! && jobIndex === jobsTot && jobsTot < paginationSize) {
                            const loadJobsResult = await AuthenticatedStrategy._loadJobs(page, jobsTot);

                            if (loadJobsResult.success) {
                                jobsTot = loadJobsResult.count;
                            }
                        }

                        if (jobIndex === jobsTot) {
                            break;
                        }
                        else {
                            continue;
                        }
                    }

                    // Try to load job details and extract job link
                    logger.debug(tag, 'Evaluating selectors', [
                        selectors.jobs,
                    ]);

                    loadDetailsResult = await AuthenticatedStrategy._loadJobDetails(page, jobId!);

                    // Check if loading job details has failed
                    if (!loadDetailsResult.success) {
                        logger.error(tag, loadDetailsResult.error);
                        jobIndex += 1;
                        continue;
                    }

                    // Use custom description function if available
                    logger.debug(tag, 'Evaluating selectors', [
                        selectors.description,
                    ]);

                    if (query.options?.descriptionFn) {
                        [jobDescription, jobDescriptionHTML] = await Promise.all([
                            page.evaluate(`(${query.options.descriptionFn.toString()})();`),
                            page.evaluate((selector) => {
                                return (<HTMLElement>document.querySelector(selector)).outerHTML;
                            }, selectors.description)
                        ]);
                    }
                    else {
                        [jobDescription, jobDescriptionHTML] = await page.evaluate((selector) => {
                                const el = (<HTMLElement>document.querySelector(selector));
                                return [el.innerText, el.outerHTML];
                            },
                            selectors.description
                        );
                    }

                    jobDescription = jobDescription as string;

                    // Extract date text (eg '1 week ago')
                    jobDateText = await page.evaluate((selector) => {
                        const el = document.querySelector(selector) as HTMLElement | null;

                        if (el) {
                            return el.innerText;
                        }
                        else {
                            return '';
                        }
                    }, selectors.dateText);

                    // Extract company link
                    jobCompanyLink = await page.evaluate((selector) => {
                        const el = document.querySelector(selector);

                        if (el) {
                            return el.getAttribute("href") || '';
                        }
                        else {
                            return '';
                        }
                    }, selectors.companyLink);

                    // Extract required skills
                    logger.debug(tag, 'Evaluating selectors', [
                        selectors.requiredSkills,
                    ]);

                    if (query.options?.skills) {
                        try {
                            await page.waitForSelector(selectors.requiredSkills, {timeout: 2000});

                            jobSkills = await page.evaluate((jobSkillsSelector: string) => {
                                const nodes = document.querySelectorAll(jobSkillsSelector);

                                if (!nodes.length) {
                                    return undefined;
                                }

                                return Array.from(nodes)
                                    .flatMap(e => e.textContent!.split(/,|and/))
                                    .map(e => e.replace(/[\n\r\t ]+/g, ' ').trim())
                                    .filter(e => e.length);
                            }, selectors.requiredSkills);
                        }
                        catch(err) {
                            logger.info('Timeout loading skills selector');
                        }
                    }

                    // Extract job insights
                    logger.debug(tag, 'Evaluating selectors', [
                        selectors.insights,
                    ]);

                    jobInsights = await page.evaluate((jobInsightsSelector: string) => {
                        const nodes = document.querySelectorAll(jobInsightsSelector);
                        return Array.from(nodes).map(e => e.textContent!
                            .replace(/[\n\r\t ]+/g, ' ').trim());
                    }, selectors.insights);

                    // Apply link
                    if (query.options?.applyLink) {
                        const applyLinkRes = await AuthenticatedStrategy._extractApplyLink(page, cdpSession, tag);

                        if (applyLinkRes.success) {
                            jobApplyLink = applyLinkRes.url as string;
                        }
                    }
                }
                catch(err: any) {
                    const errorMessage = `${tag}\t${err.message}`;
                    logger.error(tag, `Error extracting job ${jobIndex + 1}:`, err.message);
                    logger.debug(tag, `Error stack:`, err.stack);
                    this.scraper.emit(events.scraper.error, errorMessage);
                    jobIndex++;
                    metrics.failed++;
                    
                    // If we're failing on multiple jobs, try to refresh the job count
                    if (metrics.failed > 3 && metrics.failed % 3 === 0) {
                        logger.warn(tag, `Multiple extraction failures, refreshing job count...`);
                        const newJobsTot = await page.evaluate((jobSelector) => {
                            return document.querySelectorAll(jobSelector).length;
                        }, selectors.jobs);
                        
                        if (newJobsTot !== jobsTot) {
                            logger.info(tag, `Job count changed from ${jobsTot} to ${newJobsTot}`);
                            jobsTot = newJobsTot;
                        }
                    }
                    
                    continue;
                }

                // Emit data (NB: should be outside of try/catch block to be properly tested)
                this.scraper.emit(events.scraper.data, {
                    query: query.query || "",
                    location: location,
                    jobId: jobId!,
                    jobIndex: jobIndex,
                    link: jobLink!,
                    applyLink: jobApplyLink,
                    title: normalizeString(jobTitle!),
                    company: normalizeString(jobCompany!),
                    companyLink: jobCompanyLink,
                    companyImgLink: jobCompanyImgLink,
                    place: normalizeString(jobPlace!),
                    description: jobDescription! as string,
                    descriptionHTML: jobDescriptionHTML! as string,
                    date: jobDate!,
                    dateText: jobDateText!,
                    insights: jobInsights,
                    skills: jobSkills,
                });

                jobIndex += 1;
                metrics.processed += 1;
                logger.info(tag, `Processed`);

                // Try fetching more jobs
                if (metrics.processed < query.options!.limit! && jobIndex === jobsTot && jobsTot < paginationSize) {
                    const loadJobsResult = await AuthenticatedStrategy._loadJobs(page, jobsTot);

                    if (loadJobsResult.success) {
                        jobsTot = loadJobsResult.count;
                    }
                }

                if (jobIndex === jobsTot) {
                    break;
                }
            }

            tag = `[${query.query}][${location}]`;

            logger.info(tag, 'No more jobs to process in this page');

            // Check if we reached the limit of jobs to process
            if (metrics.processed === query.options!.limit!) {
                logger.info(tag, 'Query limit reached!')

                // Emit metrics
                this.scraper.emit(events.scraper.metrics, metrics);
                logger.info(tag, 'Metrics:', metrics);

                break;
            }
            else {
                metrics.missed += paginationSize - jobIndex;
            }

            // Emit metrics
            this.scraper.emit(events.scraper.metrics, metrics);
            logger.info(tag, 'Metrics:', metrics);

            // Try to paginate
            paginationIndex += 1;
            logger.info(tag, `Pagination requested [${paginationIndex}]`);
            const paginationResult = await AuthenticatedStrategy._paginate(page, tag);

            if (!paginationResult.success) {
                logger.info(tag, `Couldn\'t find more jobs for the running query`);
                break;
            }
        }

        return { exit: false };
    }
}
