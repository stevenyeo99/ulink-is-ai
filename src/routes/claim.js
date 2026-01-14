const express = require('express');
const claimController = require('../controllers/claimController');

const router = express.Router();

// get json format like ULINK GPT Excel
router.post('/pre_approval/json', claimController.preApprovalJson);
// Get Member Info API
router.post('/ias/get_member_info_by_policy', claimController.getMemberInfoByPolicy);
// Build IAS Pre-Approval Payload API
router.post('/ias/prepare_ias_pre_approval_payload', claimController.prepareIasPreApprovalPayload);
// Submit Claim Pre-Approval API
router.post('/ias/claim_pre_approval', claimController.claimPreApproval);


// Claim Pre-Approval End-to-End flow API
router.post('/ias/submit/claim_pre_approval', claimController.submitClaimPreApproval);

module.exports = router;
