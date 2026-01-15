const express = require('express');
const healthRouter = require('./health');
const claimRouter = require('./claim');
const emailRouter = require('./email');
const claimController = require('../controllers/claimController');

const router = express.Router();

router.use('/', healthRouter);
router.use('/claim', claimRouter);
router.use('/email', emailRouter);
router.post('/provider_claim/json/excel', claimController.providerClaimJsonExcel);
router.post('/member_claim/json', claimController.memberClaimJson);

module.exports = router;
