import { RunStrategy, IRunStrategyResult, ILoadResult } from "./RunStrategy";
import { Browser, Page, CDPSession } from "puppeteer";
import { events } from "../events";
import { sleep } from "../../utils/utils";
import { IQuery } from "../query";
import { logger } from "../../logger/logger";

export class Selectors {
    static switchSelectors = false;

    static get container() {
        return !this.switchSelectors ? '.jobs-search__results-list' :
            '.two-pane-serp-page__results-list';
    }

    static get jobs() {
        return '.jobs-search__results-list > li:has(.base-card__full-link)';
    }

    static get links() {
        return 'a.base-card__full-link';
    }

    static get applyLink() {
        return 'a[data-is-offsite-apply=true]';
    }

    static get dates() {
        return 'time';
    }

    static get companies() {
        return !this.switchSelectors ? '.base-search-card__subtitle' :
            '.base-search-card__subtitle';
    }

    static get places() {
        return !this.switchSelectors ? '.job-search-card__location' :
            '.job-search-card__location';
    }

    static get detailsPanel() {
        return '.details, .details-pane__content';
    }

    static get description() {
        return '.description__text .show-more-less-html__markup';
    }

    static get seeMoreJobs() {
        return 'button.infinite-scroller__show-more-button';
    }
}

/**
 * @class AnonymousStrategy
 * @extends RunStrategy
 */
export class AnonymousStrategy extends RunStrategy {

    /**
     * Verify if authentication is required
     * @param {Page} page
     * @returns {Promise<boolean>}
     * @static
     * @private
     */
    private static _needsAuthentication = async (
        page: Page
    ): Promise<boolean> => {
        const parsed = new URL(await page.url());
        return /authwall|checkpoint|challenge|\/login|\/signup/i.test(parsed.pathname);
    };

    /**
     * Wait for job details to load
     * @param page {Page}
     * @param jobId {string}
     * @param timeout {number}
     * @returns {Promise<ILoadResult>}
     * @static
     * @private
     */
    private static _loadJobDetails = async (
        page: Page,
        jobId: string,
        timeout: number = 2000
    ): Promise<ILoadResult> => {
        const waitTime = 50;
        let elapsed = 0;
        let loaded = false;

        while(!loaded) {
            loaded = await page.evaluate(
                (
                    jobId: string,
                    panelSelector: string,
                    descriptionSelector: string
                ) => {
                    const detailsPanel = document.querySelector(panelSelector) as HTMLElement;
                    const description = document.querySelector(descriptionSelector) as HTMLElement;
                    return detailsPanel && detailsPanel.innerHTML.includes(jobId) &&
                        description && description.innerText.length > 0;
                },
                jobId,
                Selectors.detailsPanel,
                Selectors.description
            );

            if (loaded) return { success: true };

            await sleep(waitTime);
            elapsed += waitTime;

            if (elapsed >= timeout) {
                return {
                    success: false,
                    error: `Timeout on loading job details`
                };
            }
        }

        return { success: true };
    };

    /**
     * Try to load more jobs
     * @param page {Page}
     * @param jobLinksTot {number}
     * @param timeout {number}
     * @returns {Promise<ILoadResult>}
     * @private
     */
    private static _loadMoreJobs = async (
        page: Page,
        jobLinksTot: number,
        timeout: number = 30000
    ): Promise<ILoadResult> => {
        const deadline = Date.now() + timeout;
        let clicked = false;

        while (Date.now() < deadline) {
            if (await AnonymousStrategy._needsAuthentication(page)) {
                throw new Error('Public pagination requires authentication.');
            }
            const state: { count: number; didClick: boolean } = await page.evaluate(
                (selector: string, buttonSelector: string, alreadyClicked: boolean) => {
                    const cards = document.querySelectorAll(selector);
                    // scrollIntoView also scrolls a nested results pane, if present.
                    cards[cards.length - 1]?.scrollIntoView({ block: 'end' });
                    window.scrollTo(0, document.body.scrollHeight);
                    const button = document.querySelector<HTMLButtonElement>(buttonSelector);
                    let didClick = false;
                    if (!alreadyClicked && button && !button.disabled &&
                        button.getClientRects().length > 0 &&
                        getComputedStyle(button).visibility !== 'hidden') {
                        button.click();
                        didClick = true;
                    }
                    return { count: cards.length, didClick };
                },
                Selectors.jobs,
                Selectors.seeMoreJobs,
                clicked
            );
            clicked = clicked || state.didClick;
            if (state.count > jobLinksTot) {
                logger.info(`Public pagination loaded ${state.count - jobLinksTot} additional jobs (${state.count} total).`);
                return { success: true };
            }
            await sleep(1000);
        }
        return { success: false, error: `No additional job cards loaded within ${timeout / 1000} seconds.` };
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
        logger.info(`[${query.query}][${location}] Using public unauthenticated LinkedIn pages; no session cookie will be used.`);

        let tag = `[${query.query}][${location}]`;
        let processed = 0;

        logger.info(tag, "Opening", url);

        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        if (!response || response.status() >= 400 || page.url().startsWith('chrome-error:')) {
            throw new Error(`Public job search failed (HTTP ${response?.status() ?? 'unknown'}).`);
        }

        // Verify if authentication is required
        if ((await AnonymousStrategy._needsAuthentication(page))) {
            logger.error(tag, "Scraper failed to run in anonymous mode, authentication may be necessary for this environment. Please check the documentation on how to use an authenticated session.")
            return { exit: true };
        }

        // Linkedin seems to randomly load two different set of selectors:
        // the following hack tries to switch between the two sets

        // Try to load first set of selectors
        try {
            Selectors.switchSelectors = false;
            logger.info(tag, 'Waiting for public job list');
            logger.debug(tag, `Evaluating selectors`, [Selectors]);
            await page.waitForSelector(Selectors.container, { timeout: 15000 });
        }
        catch(err: any) {
            // Try to load second set of selectors
            try {
                Selectors.switchSelectors = true;
                logger.info(tag, 'Checking alternate public job layout');
                logger.debug(tag, `Evaluating selectors`, [Selectors.container]);
                await page.waitForSelector(Selectors.container, { timeout: 3000 });
            }
            catch(err: any) {
                const state = await page.evaluate(() => ({
                    path: window.location.origin + window.location.pathname,
                    title: document.title,
                    cards: document.querySelectorAll('.base-search-card').length,
                }));
                throw new Error(`Public search container missing: ${JSON.stringify(state)}. This is a page-load or markup failure, not a confirmed empty search.`);
            }
        }

        logger.info(tag, 'OK');

        let jobIndex = 0;

        // Pagination loop
        while (processed < query.options!.limit!) {
            await AnonymousStrategy._acceptCookies(page, tag);

            // Get number of all job links in the page
            let jobsTot = await page.evaluate(
                (selector) => document.querySelectorAll(selector).length,
                Selectors.jobs
            );

            if (jobsTot === 0) {
                logger.info(tag, `No jobs found, skip`);
                break;
            }

            logger.info(tag, "Jobs fetched: " + jobsTot);

            // Collect search batches before opening individual job detail pages.
            while (jobsTot < query.options!.limit!) {
                const result = await AnonymousStrategy._loadMoreJobs(page, jobsTot);
                if (!result.success) {
                    logger.info(tag, "No more jobs loaded during the wait window.", result.error);
                    break;
                }
                const total = await page.evaluate(
                    (selector) => document.querySelectorAll(selector).length,
                    Selectors.jobs
                );
                logger.info(tag, `Jobs fetched (load more): ${total - jobsTot} (${total} total)`);
                jobsTot = total;
            }
            logger.info(tag, `Collection complete. Extracting details for up to ${Math.min(jobsTot, query.options!.limit!)} jobs.`);

            // Jobs loop
            while (jobIndex < jobsTot && processed < query.options!.limit!) {
                tag = `[${query.query}][${location}][${processed + 1}]`;

                let jobId;
                let jobLink;
                let jobApplyLink;
                let jobTitle;
                let jobCompany;
                let jobPlace;
                let jobDescription;
                let jobDescriptionHTML;
                let jobDate;
                let jobSenorityLevel;
                let jobFunction;
                let jobEmploymentType;
                let jobIndustries;
                let detailPage: Page | undefined;

                try {
                    // Extract job main fields
                    logger.debug(tag, `Evaluating selectors`, [
                        Selectors.jobs,
                        Selectors.links,
                        Selectors.companies,
                        Selectors.places,
                        Selectors.dates,
                    ]);

                    [jobId, jobLink, jobTitle, jobCompany, jobPlace, jobDate] = await page.evaluate(
                        (
                            jobsSelector: string,
                            linksSelector: string,
                            companiesSelector: string,
                            placesSelector: string,
                            datesSelector: string,
                            jobIndex: number
                        ) => {
                            const job = document.querySelectorAll(jobsSelector)[jobIndex];
                            const link = job.querySelector(linksSelector) as HTMLElement;

                            // Read the list without navigating away from it.
                            const linkUrl = link.getAttribute("href");

                            let jobId: string | null = '';

                            // Try first set of selectors
                            jobId = job.getAttribute('data-id');

                            // If failed, try second set of selectors
                            if (!jobId) {
                                jobId = (<HTMLElement>job.querySelector(linksSelector))
                                    .parentElement!.getAttribute('data-entity-urn')!
                                    .split(':').splice(-1)[0];
                            }

                            return [
                                jobId,
                                linkUrl,
                                (job.querySelector('.base-search-card__title')?.textContent || link.textContent || '').trim(),
                                (<HTMLElement>job.querySelector(companiesSelector)).innerText,
                                (<HTMLElement>job.querySelector(placesSelector)).innerText,
                                (<HTMLElement>job.querySelector(datesSelector)).getAttribute('datetime')
                            ];
                        },
                        Selectors.jobs,
                        Selectors.links,
                        Selectors.companies,
                        Selectors.places,
                        Selectors.dates,
                        jobIndex
                    );

                    // Load job details and extract job link
                    logger.debug(tag, `Evaluating selectors`, [
                        Selectors.links,
                    ]);

                    detailPage = await browser.newPage();
                    const detailResponse = await detailPage.goto(jobLink!, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    if (!detailResponse || detailResponse.status() >= 400 || await AnonymousStrategy._needsAuthentication(detailPage)) {
                        throw new Error(`Public job detail unavailable (HTTP ${detailResponse?.status() ?? 'unknown'}).`);
                    }
                    await detailPage.waitForSelector(Selectors.description, { timeout: 15000 });

                    // Use custom description function if available
                    logger.debug(tag, `Evaluating selectors`, [
                        Selectors.description
                    ]);

                    if (query.options?.descriptionFn) {
                        [jobDescription, jobDescriptionHTML] = await Promise.all([
                            detailPage.evaluate(`(${query.options.descriptionFn.toString()})();`),
                            detailPage.evaluate((selector) => {
                                return (<HTMLElement>document.querySelector(selector)).outerHTML;
                            }, Selectors.description)
                        ]);
                    }
                    else {
                        [jobDescription, jobDescriptionHTML] = await detailPage.evaluate((selector) => {
                                const el = (<HTMLElement>document.querySelector(selector));
                                return [el.innerText, el.outerHTML];
                            },
                            Selectors.description
                        );
                    }

                    // Extract apply link
                    logger.debug(tag, `Evaluating selectors`, [
                        Selectors.applyLink
                    ]);

                    jobApplyLink = await detailPage.evaluate((selector) => {
                        const applyBtn = document.querySelector<HTMLElement>(selector);
                        return applyBtn ? applyBtn.getAttribute("href") : null;
                    }, Selectors.applyLink);
                }
                catch(err: any) {
                    const errorMessage = `${tag}\t${err.message}`;
                    this.scraper.emit(events.scraper.error, errorMessage);
                    jobIndex += 1;
                    continue;
                }
                finally {
                    await detailPage?.close();
                }

                // Emit data
                this.scraper.emit(events.scraper.data, {
                    query: query.query || "",
                    location: location,
                    jobId: jobId!,
                    jobIndex: jobIndex,
                    link: jobLink!,
                    ...jobApplyLink && { applyLink: jobApplyLink },
                    title: jobTitle!,
                    company: jobCompany!,
                    place: jobPlace!,
                    description: jobDescription! as string,
                    descriptionHTML: jobDescriptionHTML! as string,
                    date: jobDate!,
                    dateText: '',
                    insights: [],
                });

                jobIndex += 1;
                processed += 1;
                logger.info(tag, `Processed`);

            }

            break;
        }

        return { exit: false };
    }
}
