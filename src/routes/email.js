const express = require('express');
const emailController = require('../controllers/emailController');

const router = express.Router();

router.get('/imap/import', emailController.importEmails);

module.exports = router;