const { Retell } = require('retell-sdk');
const logger = require('./logger');

class RetellClient {
    constructor() {
        this.client = new Retell({
            apiKey: process.env.RETELL_API_KEY,
        });

        this.fromNumber = process.env.RETELL_FROM_NUMBER || '+17787691188';
        this.agentId = process.env.RETELL_AGENT_ID || 'agent_826371748c85ca36277cae28c2';

        // Store active calls for correlation with webhooks
        this.activeCalls = new Map();
        // Track surveys being processed to prevent duplicates
        this.activeSurveys = new Map(); // surveyId -> { callId, createdAt, customerName, phoneNumber }
    }

    /**
     * Check if a survey is already being processed
     * @param {number} surveyId - Survey ID to check
     * @returns {boolean} True if survey is already being processed
     */
    isSurveyBeingProcessed(surveyId) {
        return this.activeSurveys.has(surveyId);
    }

    /**
     * Create an outbound phone call via Retell
     * @param {Object} surveyData - Survey response data from database
     * @returns {Promise<Object>} Call creation response
     */
    async createPhoneCall(surveyData) {
        const surveyId = surveyData.survey_id;

        // Check if this survey is already being processed
        if (this.isSurveyBeingProcessed(surveyId)) {
            const existingCall = this.activeSurveys.get(surveyId);
            logger.warn({
                surveyId,
                existingCallId: existingCall.callId,
                customerName: surveyData.customer_name
            }, 'Survey is already being processed - skipping duplicate call creation');

            throw new Error(`Survey ${surveyId} is already being processed`);
        }

        try {
            const callPayload = {
                from_number: this.fromNumber,
                to_number: surveyData.client_phone_number,
                retell_llm_dynamic_variables: {
                    name: surveyData.customer_name,
                    phone_number: surveyData.client_phone_number,
                    email: surveyData.client_email,
                    service: surveyData.business_type,
                    budget: surveyData.revenue,
                    frustration: surveyData.operational_frustration,
                    inefficiencies: surveyData.inefficiencies,
                    priority_automation: surveyData.one_task_to_automate,
                    important_outcome: surveyData.important_outcome,
                    survey_date: surveyData.survey_date
                },
                metadata: {
                    survey_id: surveyId.toString()
                },
                override_agent_id: this.agentId
            };

            logger.info({
                surveyId,
                toNumber: surveyData.client_phone_number,
                customerName: surveyData.customer_name
            }, 'Creating Retell phone call');

            const phoneCallResponse = await this.client.call.createPhoneCall(callPayload);

            // Store call correlation for webhook processing
            this.activeCalls.set(phoneCallResponse.call_id, {
                surveyId,
                createdAt: new Date(),
                customerName: surveyData.customer_name,
                phoneNumber: surveyData.client_phone_number
            });

            // Track survey as being processed
            this.activeSurveys.set(surveyId, {
                callId: phoneCallResponse.call_id,
                createdAt: new Date(),
                customerName: surveyData.customer_name,
                phoneNumber: surveyData.client_phone_number
            });

            logger.info({
                surveyId,
                callId: phoneCallResponse.call_id,
                agentId: phoneCallResponse.agent_id,
                metadata: phoneCallResponse.metadata
            }, 'Retell phone call created successfully');

            return phoneCallResponse;

        } catch (error) {
            logger.error({
                err: error,
                surveyId,
                toNumber: surveyData.client_phone_number
            }, 'Failed to create Retell phone call');
            throw error;
        }
    }

    /**
     * Handle webhook from Retell when call ends
     * @param {Object} webhookPayload - Webhook payload from Retell
     * @returns {Promise<Object>} Processing result
     */
    // async handleWebhook(webhookPayload) {
    //     try {
    //         const { event, call } = webhookPayload;

    //         logger.info({
    //             event,
    //             callId: call.call_id,
    //             callStatus: call.call_status,
    //             surveyId: call.metadata?.survey_id
    //         }, 'Received Retell webhook');

    //         if (event === 'call_ended') {
    //             const surveyId = call.metadata?.survey_id;

    //             if (!surveyId) {
    //                 logger.warn({ callId: call.call_id }, 'Webhook missing survey_id in metadata');
    //                 return { success: false, reason: 'Missing survey_id' };
    //             }

    //             const surveyIdInt = parseInt(surveyId, 10);

    //             // Remove from active calls tracking
    //             const callInfo = this.activeCalls.get(call.call_id);
    //             if (callInfo) {
    //                 this.activeCalls.delete(call.call_id);

    //                 const duration = new Date() - callInfo.createdAt;
    //                 logger.info({
    //                     surveyId: surveyIdInt,
    //                     callId: call.call_id,
    //                     duration,
    //                     disconnectionReason: call.disconnection_reason,
    //                     customerName: callInfo.customerName
    //                 }, 'Call completed, ready to mark as processed');
    //             }

    //             // Remove from active surveys tracking
    //             if (this.activeSurveys.has(surveyIdInt)) {
    //                 this.activeSurveys.delete(surveyIdInt);
    //                 logger.debug({
    //                     surveyId: surveyIdInt,
    //                     callId: call.call_id
    //                 }, 'Removed survey from active processing list');
    //             }

    //             return {
    //                 success: true,
    //                 surveyId: surveyIdInt,
    //                 callId: call.call_id,
    //                 callStatus: call.call_status,
    //                 disconnectionReason: call.disconnection_reason,
    //                 transcript: call.transcript
    //             };
    //         }

    //         // Handle other events if needed (call_analyzed, etc.)
    //         logger.debug({ event, callId: call.call_id }, 'Received non-call_ended webhook event');

    //         return { success: true, event, processed: false };

    //     } catch (error) {
    //         logger.error({ err: error, webhookPayload }, 'Failed to handle Retell webhook');
    //         throw error;
    //     }
    // }

    /**
     * Get call status from Retell API (for polling fallback if needed)
     * @param {string} callId - Retell call ID
     * @returns {Promise<Object>} Call status
     */
    async getCallStatus(callId) {
        try {
            const call = await this.client.call.retrieve(callId);

            logger.debug({
                callId,
                callStatus: call.call_status,
                disconnectionReason: call.disconnection_reason
            }, 'Retrieved call status from Retell');

            return call;

        } catch (error) {
            logger.error({ err: error, callId }, 'Failed to get call status from Retell');
            throw error;
        }
    }

    /**
     * Cleanup old active calls and surveys (in case webhooks are missed)
     * @param {number} maxAgeMs - Maximum age in milliseconds
     */
    cleanupOldCalls(maxAgeMs = 30 * 60 * 1000) { // 30 minutes default
        const now = new Date();
        const callsToRemove = [];
        const surveysToRemove = [];

        // Cleanup old active calls
        for (const [callId, callInfo] of this.activeCalls.entries()) {
            if (now - callInfo.createdAt > maxAgeMs) {
                callsToRemove.push(callId);
            }
        }

        // Cleanup old active surveys
        for (const [surveyId, surveyInfo] of this.activeSurveys.entries()) {
            if (now - surveyInfo.createdAt > maxAgeMs) {
                surveysToRemove.push(surveyId);
            }
        }

        // Remove old calls
        for (const callId of callsToRemove) {
            const callInfo = this.activeCalls.get(callId);
            this.activeCalls.delete(callId);

            logger.warn({
                callId,
                surveyId: callInfo.surveyId,
                age: now - callInfo.createdAt
            }, 'Cleaned up old active call (possible missed webhook)');
        }

        // Remove old surveys
        for (const surveyId of surveysToRemove) {
            const surveyInfo = this.activeSurveys.get(surveyId);
            this.activeSurveys.delete(surveyId);

            logger.warn({
                surveyId,
                callId: surveyInfo.callId,
                age: now - surveyInfo.createdAt
            }, 'Cleaned up old active survey (possible missed webhook) - will allow retry');
        }

        if (callsToRemove.length > 0 || surveysToRemove.length > 0) {
            logger.info({
                cleanedUpCalls: callsToRemove.length,
                cleanedUpSurveys: surveysToRemove.length
            }, 'Cleaned up old active calls and surveys');
        }
    }

    /**
     * Get active calls count for monitoring
     * @returns {number} Number of active calls
     */
    getActiveCallsCount() {
        return this.activeCalls.size;
    }

    /**
     * Get active surveys count for monitoring
     * @returns {number} Number of active surveys
     */
    getActiveSurveysCount() {
        return this.activeSurveys.size;
    }

    /**
     * Get list of active survey IDs for debugging
     * @returns {number[]} Array of active survey IDs
     */
    getActiveSurveyIds() {
        return Array.from(this.activeSurveys.keys());
    }

    /**
     * Retry mechanism with exponential backoff for Retell API calls
     * @param {Function} operation - The operation to retry
     * @param {number} maxRetries - Maximum number of retries
     * @param {number} baseDelay - Base delay in milliseconds
     * @returns {Promise<any>} Result of the operation
     */
    async withRetry(operation, maxRetries = 3, baseDelay = 1000) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                // Don't retry on certain HTTP status codes
                if (error.status === 400 || error.status === 401 || error.status === 403) {
                    throw error;
                }

                // Don't retry if survey is already being processed
                if (error.message && error.message.includes('already being processed')) {
                    throw error;
                }

                if (attempt === maxRetries) {
                    break;
                }

                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000; // Add jitter
                logger.warn({
                    err: error,
                    attempt,
                    maxRetries,
                    delayMs: delay
                }, 'Retell API operation failed, retrying');

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }
}

module.exports = RetellClient;