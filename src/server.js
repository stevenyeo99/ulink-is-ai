require('dotenv').config();
const createDebug = require('debug');
const app = require('./app');

const debug = createDebug('app:server');
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  debug(`Server listening on port ${PORT}`);
  console.log(`Server running at http://localhost:${PORT}`);
});
