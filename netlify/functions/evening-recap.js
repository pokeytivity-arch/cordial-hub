// Runs every day at 8:00 pm Nigerian time (19:00 UTC), set in netlify.toml.
const recap = require("./recap.js");
exports.handler = async () => {
  const r = await recap.run();
  return { statusCode: r.code, body: JSON.stringify(r.body) };
};
