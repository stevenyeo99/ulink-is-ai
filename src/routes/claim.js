const express = require('express');
const claimController = require('../controllers/claimController');

const router = express.Router();

router.post('/pre_approval/json', claimController.preApprovalJson);

module.exports = router;
