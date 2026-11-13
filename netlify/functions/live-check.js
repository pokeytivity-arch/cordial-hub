// Checks every 10 minutes from 7:00 am to noon Nigerian time on weekdays (06:00-10:59 UTC), set in netlify.toml,
// so the "Live now" button knows when the channel is streaming.
const feed = require("./feed.js");
exports.handler = (event, context) => feed.handler({ ...event, force: true }, context);
