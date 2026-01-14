const express = require('express');
const claimController = require('../controllers/claimController');

const router = express.Router();

router.post('/pre_approval/json', claimController.preApprovalJson);
router.post('/ias/get_member_info_by_policy', claimController.getMemberInfoByPolicy);

module.exports = router;
