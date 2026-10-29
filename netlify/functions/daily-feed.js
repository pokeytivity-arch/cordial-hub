// Runs every day at 7:00 am Nigerian time (06:00 UTC), set in netlify.toml.
const feed = require("./feed.js");
exports.handler = (event, context) => feed.handler({ ...event, force: true }, context);
