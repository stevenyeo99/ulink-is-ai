const express = require('express');
const healthRouter = require('./health');
const claimRouter = require('./claim');
const emailRouter = require('./email');

const router = express.Router();

router.use('/', healthRouter);
router.use('/claim', claimRouter);
router.use('/email', emailRouter);

module.exports = router;
