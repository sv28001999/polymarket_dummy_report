const express = require('express');
const app = express();
const orderRoutes = require('./routes/autoRoutes');
require('dotenv').config();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.use('/', orderRoutes);

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'API is running',
        endpoints: {
            serverTime: '/getServerTime'
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: 'Server error',
        error: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

// Keep the process alive on unexpected errors instead of crashing.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
});

module.exports = app;