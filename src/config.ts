const config = {
    // Read the LinkedIn session cookie from environment variables
    // Make sure you have LI_AT_COOKIE set in your .env file
    LI_AT_COOKIE: process.env.LI_AT_COOKIE || "",
};

export {
    config,
};
