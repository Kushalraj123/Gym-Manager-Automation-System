const serverHandler = require('../backend/server');

module.exports = async (req, res) => {
  return serverHandler(req, res);
};
