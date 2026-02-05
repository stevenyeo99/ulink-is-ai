const express = require('express');
const claimController = require('../controllers/claimController');

const router = express.Router();

// get json format like ULINK GPT Excel
router.post('/provider_claim/json', claimController.providerClaimJson);
// get benefit set selection from provider claim documents
router.post('/provider_claim/benefit_set/json', claimController.providerClaimBenefitSetJson);
// get excel format from provider claim json
router.post('/provider_claim/json/excel', claimController.providerClaimJsonExcel);
// Get Member Info API
router.post('/ias/get_member_info_by_policy', claimController.getMemberInfoByPolicy);
// Build IAS Provider Claim Payload API
router.post('/ias/prepare_ias_provider_claim_payload', claimController.prepareIasProviderClaimPayload);

// Submit Claim Provider Claim API
router.post('/ias/claim_provider_claim', claimController.claimProviderClaim);


// Claim Provider Claim End-to-End flow API
router.post('/ias/submit/provider_claim', claimController.submitClaimProviderClaim);





// get json format for member claim OCR
router.post('/member_claim/json', claimController.memberClaimJson);
// Build IAS Reimbursement Benefit Set API
router.post(
  '/ias/prepare_ias_reimbursement_benefit_set',
  claimController.prepareIasReimbursementBenefitSetController
);
// Get IAS Benefit List from coverage limits
router.post('/ias/get_benefit_list', claimController.getIasBenefitList);
// Build IAS Reimbursement Claim Payload API
router.post(
  '/ias/prepare_ias_reimbursement_claim_payload',
  claimController.prepareIasReimbursementClaimPayload
);
// Submit Reimbursement Claim API
router.post('/ias/submit/reimbursement_claim', claimController.submitReimbursementClaim);
// Claim Status API
router.post('/ias/get_claim_status', claimController.getClaimStatus);
// Download IAS file API
router.post('/ias/download', claimController.downloadClaimFileController);
// Reimbursement Claim End-to-End flow API
router.post('/ias/reimbursement/claim/process', claimController.processReimbursementClaim);

module.exports = router;
