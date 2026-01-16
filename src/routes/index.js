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
router.post(
  '/ias/prepare_ias_reimbursement_benefit_set',
  claimController.prepareIasReimbursementBenefitSetController
);
router.post(
  '/ias/prepare_ias_reimbursement_claim_payload',
  claimController.prepareIasReimbursementClaimPayload
);
router.post('/ias/submit/reimbursement_claim', claimController.submitReimbursementClaim);

module.exports = router;
