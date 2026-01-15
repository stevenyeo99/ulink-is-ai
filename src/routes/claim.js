const express = require('express');
const claimController = require('../controllers/claimController');

const router = express.Router();

// get json format like ULINK GPT Excel
router.post('/provider_claim/json', claimController.providerClaimJson);
// Get Member Info API
router.post('/ias/get_member_info_by_policy', claimController.getMemberInfoByPolicy);
// Build IAS Provider Claim Payload API
router.post('/ias/prepare_ias_provider_claim_payload', claimController.prepareIasProviderClaimPayload);
// Submit Claim Provider Claim API
router.post('/ias/claim_provider_claim', claimController.claimProviderClaim);


// Claim Provider Claim End-to-End flow API
router.post('/ias/submit/provider_claim', claimController.submitClaimProviderClaim);

module.exports = router;
