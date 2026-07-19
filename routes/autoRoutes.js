const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const { getServerTime, startScheduler, stopScheduler, startHourlyScheduler, stopHourlyScheduler
} = require('../controllers/tradeLogic');

router.route('/events').get((req, res) => {
    const filePath = path.join(__dirname, '../report.json');
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'No events file found.' });
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return res.status(200).json({ success: true, data: JSON.parse(data) });
});

router.route('/hourlyEvents').get((req, res) => {
    const filePath = path.join(__dirname, '../hourlyReport.json');
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, message: 'No hourly events file found.' });
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return res.status(200).json({ success: true, data: JSON.parse(data) });
});

router.route('/getServerTime').get(getServerTime);
router.route('/startScheduler').get(startScheduler);
router.route('/stopScheduler').get(stopScheduler);
router.route('/startHourlyScheduler').get(startHourlyScheduler);
router.route('/stopHourlyScheduler').get(stopHourlyScheduler);

module.exports = router;