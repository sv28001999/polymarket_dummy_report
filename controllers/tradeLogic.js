require('dotenv').config();
const { ClobClient } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const axios = require('axios');

const FIREBASE_BASE_URL = 'https://record-app-8c32d-default-rtdb.firebaseio.com';
// Optional: if your DB rules require auth, set FIREBASE_SECRET in .env and it will be appended automatically.
const FIREBASE_AUTH_QS = process.env.FIREBASE_SECRET ? `?auth=${process.env.FIREBASE_SECRET}` : '';

const URL = 'https://gamma-api.polymarket.com/markets/slug/btc-updown-15m-';
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-';
const GAMMA_API_SLUG_BASE = 'https://gamma-api.polymarket.com/markets/slug/';
const SERVER_BASE_URL = 'https://polymarket-server-sits.onrender.com';
const PRICE_URL = 'https://clob.polymarket.com/last-trade-price?token_id=';

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const FIVE_MIN_SECONDS = 5 * 60;
const HOUR_SECONDS = 60 * 60;
let schedulerRunning = false;
let schedulerTimeout = null;
let schedulerInterval = null;
let logicInterval = null;
let currentEventEpoch = 0;
let currentPrice = 0;
let highPrice = 0;
let lowPrice = 0;
let isInitial = true;
let isBuy = false;
let isUp = true;

let hourlySchedulerRunning = false;
let hourlySchedulerTimeout = null;
let hourlySchedulerInterval = null;
let hourlyLogicInterval = null;
let currentHourlyEventEpoch = 0;

function mapToUpDown(clobTokenIds) {
    try {
        const [up, down] = JSON.parse(clobTokenIds);
        return { UP: up, DOWN: down };
    } catch (err) {
        console.error('[mapToUpDown] Failed to parse clobTokenIds:', err.message);
        return null;
    }
}

// Pushes a record to a Firebase RTDB path using the auto-generated push-key.
// Equivalent to Firebase's `push()` — POST to a list node creates a new child.
const pushToFirebase = async (nodePath, record) => {
    try {
        const url = `${FIREBASE_BASE_URL}/${nodePath}.json${FIREBASE_AUTH_QS}`;
        await axios.post(url, record);
    } catch (err) {
        console.error(`[Firebase] Failed to write to ${nodePath}:`, err.message);
        throw err;
    }
};

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
            try {
                await pushToFirebase('events', { price, epoch: currentEventEpoch });
                console.log(`[Firebase] Saved event record for epoch ${currentEventEpoch}`);
            } catch (fbErr) {
                // pushToFirebase already logged the error; keep going so interval still clears below
            }
            isBuy = true;
            isUp = price == 1 ? true : false;
        }

        if (isBuy && isUp && price > 2) {
            await pushToFirebase('events', { price, epoch: currentEventEpoch, profit: true, side: "UP" });
            if (logicInterval) {
                clearInterval(logicInterval);
            }
        }

        if (isBuy && !isUp && price < 98) {
            await pushToFirebase('events', { price, epoch: currentEventEpoch, profit: true, side: "DOWN" });
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

const getCurrentHourlyEventEpoch = async () => {
    const currentEpoch = (await axios.get('https://clob.polymarket.com/time')).data;
    const timestampMs = currentEpoch < 10000000000 ? currentEpoch * 1000 : currentEpoch;
    const oneHour = 60 * 60 * 1000;
    const nextInterval = Math.ceil(timestampMs / oneHour) * oneHour;
    const epoch = currentEpoch < 10000000000
        ? Math.floor(nextInterval / 1000) - 3600
        : nextInterval - 3600;
    return epoch;
};

// Builds a slug like `bitcoin-up-or-down-july-19-2026-1am-et` from an epoch (seconds) in US Eastern time.
const buildHourlySlug = (epochSeconds) => {
    const date = new Date(epochSeconds * 1000);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        hour12: true,
    }).formatToParts(date);

    const get = (type) => parts.find((p) => p.type === type)?.value;
    const month = get('month').toLowerCase();
    const day = get('day');
    const year = get('year');
    const hour = get('hour');
    const period = get('dayPeriod').toLowerCase();

    return `bitcoin-up-or-down-${month}-${day}-${year}-${hour}${period}-et`;
};

const recordHourlyTrades = async (clobIds) => {
    try {
        const priceRes = await axios.get(`${PRICE_URL}${clobIds.UP}`);
        currentPrice = Math.round(priceRes.data.price * 100);
        if (isInitial) {
            highPrice = currentPrice;
            lowPrice = currentPrice;
            isInitial = false;
        }
        else {
            highPrice = currentPrice > highPrice ? currentPrice : highPrice;
            lowPrice = currentPrice < lowPrice ? currentPrice : lowPrice;
            console.log(highPrice);
            console.log(lowPrice);
        }

        if (currentPrice == 1 || currentPrice == 99) {
            try {
                await pushToFirebase('hourlyEvents', {
                    high: highPrice,
                    low: lowPrice,
                    epoch: currentHourlyEventEpoch,
                });
                console.log(`[Firebase] Saved hourly event record for epoch ${currentHourlyEventEpoch}`);
            } catch (fbErr) {
                // pushToFirebase already logged the error
            }

            if (hourlyLogicInterval) {
                clearInterval(hourlyLogicInterval);
            }
        }

    } catch (err) {
        console.error(`[recordHourlyTrades] Epoch ${currentHourlyEventEpoch} failed:`, err.message);
    }
};

const startHourlyLogic = async () => {
    if (hourlyLogicInterval) {
        clearInterval(hourlyLogicInterval);
        hourlyLogicInterval = null;
    }

    highPrice = 0;
    lowPrice = 0;
    isInitial = true;
    currentPrice = 0;

    try {
        currentHourlyEventEpoch = await getCurrentHourlyEventEpoch();
        console.log('Current hourly epoch:', currentHourlyEventEpoch);
    } catch (err) {
        console.error('[Hourly Startup] Failed to fetch current epoch — connectivity issue:', err.message);
        return;
    }

    const slug = buildHourlySlug(currentHourlyEventEpoch);
    console.log('Hourly slug:', slug);

    let eventDetails;
    try {
        eventDetails = await axios.get(`${GAMMA_API_SLUG_BASE}${slug}`);
    } catch (err) {
        console.error(`[Hourly Epoch ${currentHourlyEventEpoch}] Failed to fetch event details — connectivity issue:`, err.message);
        return;
    }

    const clobId = mapToUpDown(eventDetails.data && eventDetails.data.clobTokenIds);
    if (!clobId) {
        console.error(`[Hourly Epoch ${currentHourlyEventEpoch}] Missing or invalid clobTokenIds — skipping this cycle`);
        return;
    }

    console.log('Hourly Started', new Date().toISOString());
    hourlyLogicInterval = setInterval(() => {
        recordHourlyTrades(clobId).catch((err) => {
            console.error('[recordHourlyTrades] Unhandled error:', err.message);
        });
    }, 1500);
};

const startHourlyScheduler = async (req, res, next) => {
    try {
        if (hourlySchedulerRunning) {
            return res.status(200).json({
                success: true,
                message: 'Hourly scheduler already running'
            });
        }

        const epoch = await fetchServerEpoch();
        if (!Number.isFinite(epoch)) {
            throw new Error(`Invalid server epoch: ${epoch}`);
        }

        // Seconds remaining until the next 1-hour boundary.
        const remaining = HOUR_SECONDS - (epoch % HOUR_SECONDS);

        hourlySchedulerRunning = true;
        console.log(`Server epoch: ${epoch}, waiting ${remaining}s until next 1h boundary`);

        hourlySchedulerTimeout = setTimeout(() => {
            startHourlyLogic().catch((err) => console.error('[startHourlyLogic] Unhandled error:', err.message));
            hourlySchedulerInterval = setInterval(() => {
                startHourlyLogic().catch((err) => console.error('[startHourlyLogic] Unhandled error:', err.message));
            }, HOUR_SECONDS * 1000);
        }, (remaining * 1000) + 4000);

        return res.status(200).json({
            success: true,
            message: 'Hourly scheduler started',
            serverEpoch: epoch,
            waitSeconds: remaining
        });
    } catch (error) {
        console.error('Error starting hourly scheduler:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to start hourly scheduler',
            error: error.message
        });
    }
};

const stopHourlyScheduler = async (req, res, next) => {
    try {
        if (!hourlySchedulerRunning) {
            return res.status(200).json({
                success: true,
                message: 'Hourly scheduler not running'
            });
        }

        if (hourlySchedulerTimeout) {
            clearTimeout(hourlySchedulerTimeout);
            hourlySchedulerTimeout = null;
        }
        if (hourlySchedulerInterval) {
            clearInterval(hourlySchedulerInterval);
            hourlySchedulerInterval = null;
        }
        if (hourlyLogicInterval) {
            clearInterval(hourlyLogicInterval);
            hourlyLogicInterval = null;
        }
        hourlySchedulerRunning = false;
        console.log('Hourly scheduler stopped', new Date().toISOString());

        return res.status(200).json({
            success: true,
            message: 'Hourly scheduler stopped'
        });
    } catch (error) {
        console.error('Error stopping hourly scheduler:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to stop hourly scheduler',
            error: error.message
        });
    }
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
                let isBuy = false;
                let isUp = true;
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
    startHourlyScheduler,
    stopHourlyScheduler,
}