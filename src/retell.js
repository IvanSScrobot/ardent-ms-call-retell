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
    }

    /**
     * Create an outbound phone call via Retell
     * @param {Object} surveyData - Survey response data from database
     * @returns {Promise<Object>} Call creation response
     */
    async createPhoneCall(surveyData) {
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
                    survey_id: surveyData.survey_id.toString()
                },
                override_agent_id: this.agentId
            };

            logger.info({
                surveyId: surveyData.survey_id,
                toNumber: surveyData.client_phone_number,
                customerName: surveyData.customer_name
            }, 'Creating Retell phone call');

            const phoneCallResponse = await this.client.call.createPhoneCall(callPayload);

            // Store call correlation for webhook processing
            this.activeCalls.set(phoneCallResponse.call_id, {
                surveyId: surveyData.survey_id,
                createdAt: new Date(),
                customerName: surveyData.customer_name,
                phoneNumber: surveyData.client_phone_number
            });

            logger.info({
                surveyId: surveyData.survey_id,
                callId: phoneCallResponse.call_id,
                agentId: phoneCallResponse.agent_id,
                metadata: phoneCallResponse.metadata
            }, 'Retell phone call created successfully');

            return phoneCallResponse;

        } catch (error) {
            logger.error({
                err: error,
                surveyId: surveyData.survey_id,
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
    async handleWebhook(webhookPayload) {
        try {
            const { event, call } = webhookPayload;

            logger.info({
                event,
                callId: call.call_id,
                callStatus: call.call_status,
                surveyId: call.metadata?.survey_id
            }, 'Received Retell webhook');

            if (event === 'call_ended') {
                const surveyId = call.metadata?.survey_id;

                if (!surveyId) {
                    logger.warn({ callId: call.call_id }, 'Webhook missing survey_id in metadata');
                    return { success: false, reason: 'Missing survey_id' };
                }

                // Remove from active calls tracking
                const callInfo = this.activeCalls.get(call.call_id);
                if (callInfo) {
                    this.activeCalls.delete(call.call_id);

                    const duration = new Date() - callInfo.createdAt;
                    logger.info({
                        surveyId,
                        callId: call.call_id,
                        duration,
                        disconnectionReason: call.disconnection_reason,
                        customerName: callInfo.customerName
                    }, 'Call completed, ready to mark as processed');
                }

                return {
                    success: true,
                    surveyId: parseInt(surveyId, 10),
                    callId: call.call_id,
                    callStatus: call.call_status,
                    disconnectionReason: call.disconnection_reason,
                    transcript: call.transcript
                };
            }

            // Handle other events if needed (call_analyzed, etc.)
            logger.debug({ event, callId: call.call_id }, 'Received non-call_ended webhook event');

            return { success: true, event, processed: false };

        } catch (error) {
            logger.error({ err: error, webhookPayload }, 'Failed to handle Retell webhook');
            throw error;
        }
    }

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
     * Cleanup old active calls (in case webhooks are missed)
     * @param {number} maxAgeMs - Maximum age in milliseconds
     */
    cleanupOldCalls(maxAgeMs = 30 * 60 * 1000) { // 30 minutes default
        const now = new Date();
        const toRemove = [];

        for (const [callId, callInfo] of this.activeCalls.entries()) {
            if (now - callInfo.createdAt > maxAgeMs) {
                toRemove.push(callId);
            }
        }

        for (const callId of toRemove) {
            const callInfo = this.activeCalls.get(callId);
            this.activeCalls.delete(callId);

            logger.warn({
                callId,
                surveyId: callInfo.surveyId,
                age: now - callInfo.createdAt
            }, 'Cleaned up old active call (possible missed webhook)');
        }

        if (toRemove.length > 0) {
            logger.info({ cleanedUp: toRemove.length }, 'Cleaned up old active calls');
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