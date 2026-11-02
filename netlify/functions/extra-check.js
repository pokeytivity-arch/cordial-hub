// Runs every 15 minutes (schedule in netlify.toml) and refreshes the extra YouTube channels.
// (The hub itself asks feed-extra.js over the web; Netlify does not allow a scheduled function to be opened from the web.)
const feed = require("./feed-extra.js");
exports.handler = (event, context) => feed.handler({ ...event, queryStringParameters: { force: "1" } }, context);
