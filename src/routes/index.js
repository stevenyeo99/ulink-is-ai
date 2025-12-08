const express = require('express');
const healthRouter = require('./health');
const claimRouter = require('./claim');

const router = express.Router();

router.use('/', healthRouter);
router.use('/claim', claimRouter);

module.exports = router;
