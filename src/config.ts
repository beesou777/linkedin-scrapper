import * as dotenv from "dotenv";

dotenv.config();

const config = {
    LI_AT_COOKIE: process.env.LI_AT_COOKIE || "",
};

export {
    config,
};
