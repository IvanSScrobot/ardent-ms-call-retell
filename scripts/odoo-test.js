#!/usr/bin/env node
require('dotenv').config(); // optional: load .env if present

const odoo = require('../src/services/odooService');

async function main() {
    try {
        // 1) Health check (no auth required)
        const health = await odoo.healthCheck();
        console.log('Health:', health);

        // 2) Authenticate
        const uid = await odoo.authenticate();
        console.log('Authenticated uid:', uid);

        // 3) Create a quick test lead (adjust fields as needed)
        const lead = await odoo.createLead({
            customerName: 'Test Customer',
            surveyId: 'TEST-123',
            summary: 'This is a test lead created via JSON-RPC'
        });
        console.log('Lead creation result:', lead);
    } catch (err) {
        console.error('Test failed:', err.message);
        process.exitCode = 1;
    }
}

main();
