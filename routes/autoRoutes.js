const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { getServerTime, startScheduler, stopScheduler, startHourlyScheduler, stopHourlyScheduler
} = require('../controllers/tradeLogic');

router.route('/events').get(async (req, res) => {
    try {
        const { data } = await axios.get(`https://record-app-8c32d-default-rtdb.firebaseio.com/events.json`);
        if (!data) return res.status(404).json({ success: false, message: 'No events found.' });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.route('/hourlyEvents').get(async (req, res) => {
    try {
        const { data } = await axios.get(`https://record-app-8c32d-default-rtdb.firebaseio.com/hourlyEvents.json`);
        if (!data) return res.status(404).json({ success: false, message: 'No events found.' });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.route('/getServerTime').get(getServerTime);
router.route('/startScheduler').get(startScheduler);
router.route('/stopScheduler').get(stopScheduler);
router.route('/startHourlyScheduler').get(startHourlyScheduler);
router.route('/stopHourlyScheduler').get(stopHourlyScheduler);

module.exports = router;