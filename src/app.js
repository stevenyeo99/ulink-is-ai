const express = require('express');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const createDebug = require('debug');
const routes = require('./routes');

const debug = createDebug('app:middleware');
const app = express();

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', routes);

app.use((req, res) => {
  debug(`Not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not Found' });
});

module.exports = app;
