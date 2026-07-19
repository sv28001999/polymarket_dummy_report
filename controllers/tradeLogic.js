require('dotenv').config();
const { ClobClient } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const REPORT_FILE = path.join(__dirname, '..', 'report.json');
const URL = 'https://gamma-api.polymarket.com/markets/slug/btc-updown-15m-';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-';
const SERVER_BASE_URL = 'https://polymarket-server-sits.onrender.com';

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const FIVE_MIN_SECONDS = 5 * 60;
let schedulerRunning = false;
let schedulerTimeout = null;
let schedulerInterval = null;
let logicInterval = null;
let currentEventEpoch = 0;

function mapToUpDown(clobTokenIds) {
    try {
        const [up, down] = JSON.parse(clobTokenIds);
        return { UP: up, DOWN: down };
    } catch (err) {
        console.error('[mapToUpDown] Failed to parse clobTokenIds:', err.message);
        return null;
    }
}

const getCurrentEventEpoch = async () => {
    const currentEpoch = (await axios.get('https://clob.polymarket.com/time')).data;
    const timestampMs = currentEpoch < 10000000000 ? currentEpoch * 1000 : currentEpoch;
    const fiveMinutes = 5 * 60 * 1000;
    const nextInterval = Math.ceil(timestampMs / fiveMinutes) * fiveMinutes;
    const epoch = currentEpoch < 10000000000
        ? Math.floor(nextInterval / 1000) - 300
        : nextInterval - 300;
    return epoch;
};

const recordTrades = async (clobIDs) => {
    try {
        // console.log(clobIDs);
        const currentPriceRes = await axios.post(`${SERVER_BASE_URL}/getCurrentPrice`, {
            epochTime: currentEventEpoch,
            side: 'UP',
        });

        const price = Math.round(currentPriceRes.data.price);
        console.log(price);

        if (price == 1 || price == 99) {
            let records = [];
            if (fs.existsSync(REPORT_FILE)) {
                try {
                    records = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf-8'));
                    if (!Array.isArray(records)) records = [];
                } catch (parseErr) {
                    records = [];
                }
            }
            records.push({ price, epoch: currentEventEpoch });
            fs.writeFileSync(REPORT_FILE, JSON.stringify(records, null, 2));

            if (logicInterval) {
                clearInterval(logicInterval);
            }
        }

    } catch (err) {
        console.error(`[recordTrades] Epoch ${currentEventEpoch} failed:`, err.message);
    }
};

const startLogic = async () => {
    if (logicInterval) {
        clearInterval(logicInterval);
        logicInterval = null;
    }

    try {
        currentEventEpoch = await getCurrentEventEpoch();
        console.log('Current epoch:', currentEventEpoch);
    } catch (err) {
        console.error('[Startup] Failed to fetch current epoch — connectivity issue:', err.message);
        return;
    }

    let eventDetails;
    try {
        eventDetails = await axios.get(`${GAMMA_API_BASE}${currentEventEpoch}`);
    } catch (err) {
        console.error(`[Epoch ${currentEventEpoch}] Failed to fetch event details — connectivity issue:`, err.message);
        return;
    }

    const clobId = mapToUpDown(eventDetails.data && eventDetails.data.clobTokenIds);
    if (!clobId) {
        console.error(`[Epoch ${currentEventEpoch}] Missing or invalid clobTokenIds — skipping this cycle`);
        return;
    }

    console.log('Started', new Date().toISOString());
    logicInterval = setInterval(() => {
        recordTrades(clobId).catch((err) => {
            console.error('[recordTrades] Unhandled error:', err.message);
        });
    }, 1500);
};

const fetchServerEpoch = async () => {
    const response = await axios.get('https://clob.polymarket.com/time');
    // CLOB /time returns the epoch in seconds (as a number or numeric string)
    return Number(response.data);
};

const startScheduler = async (req, res, next) => {
    try {
        if (schedulerRunning) {
            return res.status(200).json({
                success: true,
                message: 'Scheduler already running'
            });
        }

        const epoch = await fetchServerEpoch();
        if (!Number.isFinite(epoch)) {
            throw new Error(`Invalid server epoch: ${epoch}`);
        }

        // Seconds remaining until the next 5-minute boundary.
        const remaining = FIVE_MIN_SECONDS - (epoch % FIVE_MIN_SECONDS);

        schedulerRunning = true;
        console.log(`Server epoch: ${epoch}, waiting ${remaining}s until next 5m boundary`);

        schedulerTimeout = setTimeout(() => {
            startLogic().catch((err) => console.error('[startLogic] Unhandled error:', err.message));
            schedulerInterval = setInterval(() => {
                startLogic().catch((err) => console.error('[startLogic] Unhandled error:', err.message));
            }, FIVE_MIN_SECONDS * 1000);
        }, (remaining * 1000) + 4000);

        return res.status(200).json({
            success: true,
            message: 'Scheduler started',
            serverEpoch: epoch,
            waitSeconds: remaining
        });
    } catch (error) {
        console.error('Error starting scheduler:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to start scheduler',
            error: error.message
        });
    }
};

const stopScheduler = async (req, res, next) => {
    try {
        if (!schedulerRunning) {
            return res.status(200).json({
                success: true,
                message: 'Scheduler not running'
            });
        }

        if (schedulerTimeout) {
            clearTimeout(schedulerTimeout);
            schedulerTimeout = null;
        }
        if (schedulerInterval) {
            clearInterval(schedulerInterval);
            schedulerInterval = null;
        }
        if (logicInterval) {
            clearInterval(logicInterval);
            logicInterval = null;
        }
        schedulerRunning = false;
        console.log('Scheduler stopped', new Date().toISOString());

        return res.status(200).json({
            success: true,
            message: 'Scheduler stopped'
        });
    } catch (error) {
        console.error('Error stopping scheduler:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to stop scheduler',
            error: error.message
        });
    }
};

const getServerTime = async (req, res, next) => {
    try {
        const response = await axios.get('https://clob.polymarket.com/time');

        return res.status(200).json({
            success: true,
            data: response.data,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching time:', error.message);

        return res.status(500).json({
            success: false,
            message: 'Failed to fetch server time',
            error: error.message
        });
    }
};

module.exports = {
    getServerTime,
    startScheduler,
    stopScheduler,
}