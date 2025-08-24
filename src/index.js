const logger = require('./logger');
const DatabaseClient = require('./db');
const RetellClient = require('./retell');
const ShardingManager = require('./sharding');
const HttpServer = require('./http');
const OdooService = require('./odooService');

class RetellCaller {
    constructor() {
        this.dbClient = null;
        this.retellClient = null;
        this.shardingManager = null;
        this.httpServer = null;
        this.odooService = null;
        this.processingInterval = null;
        this.odooProcessingInterval = null;
        this.cleanupInterval = null;
        this.isShuttingDown = false;

        // Configuration
        this.scanIntervalMs = parseInt(process.env.SCAN_INTERVAL_MS, 10) || 10000;
        this.odooScanIntervalMs = parseInt(process.env.ODOO_SCAN_INTERVAL_MS, 10) || 15000; // 15 seconds for Odoo processing
        this.cleanupIntervalMs = parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 300000; // 5 minutes

        // Bind signal handlers
        this.setupSignalHandlers();
    }

    /**
     * Initialize all components
     */
    async initialize() {
        try {
            logger.info('Initializing Retell Caller service...');

            // Validate required environment variables
            this.validateEnvironment();

            // Initialize components
            this.dbClient = new DatabaseClient();
            this.retellClient = new RetellClient();
            this.shardingManager = new ShardingManager();

            // Initialize Odoo service if environment variables are present
            try {
                this.odooService = new OdooService();
                logger.info('Odoo service initialized successfully');
            } catch (error) {
                logger.warn({ err: error }, 'Odoo service initialization failed - Odoo integration will be disabled');
                this.odooService = null;
            }

            this.httpServer = new HttpServer(this.dbClient, this.retellClient, this.shardingManager, this.odooService);

            // Test database connection
            const dbHealthy = await this.dbClient.healthCheck();
            if (!dbHealthy) {
                throw new Error('Database health check failed');
            }

            // Validate shard configuration
            const shardValid = await this.shardingManager.validateShardConfig();
            if (!shardValid) {
                throw new Error('Shard configuration validation failed');
            }

            // Start HTTP server
            await this.httpServer.start();

            // Log initial shard information
            const shardStats = await this.shardingManager.getShardStats();
            const exampleIds = await this.shardingManager.getExampleIds(5);

            logger.info({
                shard: shardStats,
                exampleIds,
                scanInterval: this.scanIntervalMs
            }, 'Service initialized successfully');

            return true;

        } catch (error) {
            logger.error({ err: error }, 'Failed to initialize service');
            throw error;
        }
    }

    /**
     * Validate required environment variables
     */
    validateEnvironment() {
        const required = [
            'DB_HOST',
            'DB_PORT',
            'DB_NAME',
            'POSTGRES_USER',
            'POSTGRES_PASSWORD',
            'RETELL_API_KEY',
            'POD_NAME'
        ];

        const missing = required.filter(env => !process.env[env]);

        if (missing.length > 0) {
            throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }

        logger.info('Environment validation passed');
    }

    /**
     * Start the main processing loop
     */
    async start() {
        try {
            await this.initialize();

            logger.info('Starting survey processing loop...');

            // Start processing loop
            this.processingInterval = setInterval(
                this.processSurveyResponses.bind(this),
                this.scanIntervalMs
            );

            // Start Odoo processing loop if Odoo service is available
            if (this.odooService) {
                this.odooProcessingInterval = setInterval(
                    this.processOdooLeads.bind(this),
                    this.odooScanIntervalMs
                );
                logger.info('Odoo processing loop started');
            }

            // Start cleanup loop for old active calls
            this.cleanupInterval = setInterval(
                this.cleanupOldCalls.bind(this),
                this.cleanupIntervalMs
            );

            // Start shard monitoring
            this.stopShardMonitoring = this.shardingManager.startShardMonitoring(
                this.handleShardChange.bind(this),
                30000 // Check every 30 seconds
            );

            // Initial processing run
            await this.processSurveyResponses();

            // Initial Odoo processing run if available
            if (this.odooService) {
                await this.processOdooLeads();
            }

            logger.info('Retell Caller service started successfully');

        } catch (error) {
            logger.error({ err: error }, 'Failed to start service');
            await this.shutdown();
            process.exit(1);
        }
    }

    /**
     * Main processing function - gets and processes survey responses
     */
    async processSurveyResponses() {
        if (this.isShuttingDown) {
            return;
        }

        try {
            // Get current shard information
            const { shardIndex, totalShards } = await this.shardingManager.getShardInfo();

            logger.info({ shardIndex, totalShards }, 'Processing survey responses for shard');

            // Get next survey response for this shard
            const surveyData = await this.dbClient.getNextSurveyResponse(shardIndex, totalShards, this.retellClient.activeSurveys);

            if (!surveyData) {
                logger.debug({ shardIndex, totalShards }, 'No eligible survey responses found for this shard');
                return;
            }

            // Process the survey response
            await this.processSingleSurvey(surveyData);

        } catch (error) {
            logger.error({ err: error }, 'Error in survey processing loop');

            // Don't exit on processing errors, just log and continue
            // The next iteration will try again
        }
    }

    /**
     * Process a single survey response
     */
    async processSingleSurvey(surveyData) {
        const surveyId = surveyData.survey_id;

        try {
            // Check if this survey is already being processed
            if (this.retellClient.isSurveyBeingProcessed(surveyId)) {
                logger.debug({
                    surveyId,
                    customerName: surveyData.customer_name
                }, 'Survey is already being processed - skipping');
                return;
            }

            logger.info({
                surveyId,
                customerName: surveyData.customer_name,
                phoneNumber: surveyData.client_phone_number
            }, 'Processing survey response');

            // Create Retell phone call with retry logic
            const callResponse = await this.retellClient.withRetry(
                () => this.retellClient.createPhoneCall(surveyData),
                3, // max retries
                2000 // base delay
            );

            logger.info({
                surveyId,
                callId: callResponse.call_id,
                agentId: callResponse.agent_id
            }, 'Retell call created successfully - waiting for webhook completion');

            // Note: We don't mark as processed here - that happens via webhook
            // when the call actually completes

        } catch (error) {
            // Check if this is a duplicate processing error
            if (error.message && error.message.includes('already being processed')) {
                logger.debug({
                    surveyId,
                    customerName: surveyData.customer_name
                }, 'Survey already being processed by another instance - skipping');
                return;
            }

            logger.error({
                err: error,
                surveyId,
                customerName: surveyData.customer_name
            }, 'Failed to process survey response');

            // Depending on the error type, we might want to mark it as failed
            // or let it retry on the next processing cycle
            if (error.status === 400 || error.status === 401 || error.status === 403) {
                logger.warn({
                    surveyId,
                    errorStatus: error.status
                }, 'Permanent error - survey will not be retried');

                // Could mark as processed with error flag here if needed
                // await this.dbClient.markAsProcessedWithError(surveyId, error.message);
            }
        }
    }

    /**
     * Process completed surveys for Odoo lead creation
     */
    async processOdooLeads() {
        if (this.isShuttingDown || !this.odooService) {
            return;
        }

        try {
            // Get current shard information
            const { shardIndex, totalShards } = await this.shardingManager.getShardInfo();

            logger.debug({ shardIndex, totalShards }, 'Processing Odoo leads for shard');

            // Get next processed survey response for Odoo integration
            const surveyData = await this.dbClient.getNextProcessedSurveyForOdoo(shardIndex, totalShards);

            if (!surveyData) {
                logger.debug({ shardIndex, totalShards }, 'No processed survey responses found for Odoo integration');
                return;
            }

            // Process the survey for Odoo lead creation
            await this.processSingleOdooLead(surveyData);

        } catch (error) {
            logger.error({ err: error }, 'Error in Odoo processing loop');
            // Don't exit on processing errors, just log and continue
        }
    }

    /**
     * Process a single survey response for Odoo lead creation
     */
    async processSingleOdooLead(surveyData) {
        const surveyId = surveyData.survey_id;

        try {
            logger.info({
                surveyId,
                customerName: surveyData.customer_name,
                email: surveyData.client_email
            }, 'Processing survey for Odoo lead creation');

            // Prepare lead data for Odoo
            const leadData = {
                customerName: surveyData.customer_name,
                surveyId: surveyId,
                phone: surveyData.client_phone_number,
                email: surveyData.client_email,
                summary: surveyData.summary
            };

            // Create lead in Odoo with retry logic
            const leadResult = await this.retryOperation(
                () => this.odooService.createLead(leadData),
                3, // max retries
                5000 // base delay
            );

            if (leadResult.success) {
                // Mark survey as sent to Odoo
                const updated = await this.dbClient.markAsSentToOdoo(surveyId);

                if (updated) {
                    logger.info({
                        surveyId,
                        leadId: leadResult.leadId,
                        customerName: surveyData.customer_name
                    }, 'Successfully created Odoo lead and marked survey as sent');
                } else {
                    logger.warn({
                        surveyId,
                        leadId: leadResult.leadId
                    }, 'Created Odoo lead but failed to update survey status');
                }
            }

        } catch (error) {
            logger.error({
                err: error,
                surveyId,
                customerName: surveyData.customer_name
            }, 'Failed to process survey for Odoo lead creation');

            // Depending on the error type, we might want to mark it as failed
            // or let it retry on the next processing cycle
            if (error.message && (error.message.includes('authentication') || error.message.includes('credentials'))) {
                logger.warn({
                    surveyId,
                    error: error.message
                }, 'Odoo authentication error - will retry later');
            }
        }
    }

    /**
     * Generic retry mechanism with exponential backoff
     */
    async retryOperation(operation, maxRetries = 3, baseDelay = 1000) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                if (attempt === maxRetries) {
                    break;
                }

                const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000; // Add jitter
                logger.warn({
                    err: error,
                    attempt,
                    maxRetries,
                    delayMs: delay
                }, 'Operation failed, retrying');

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    /**
     * Handle shard configuration changes
     */
    async handleShardChange({ oldShards, newShards }) {
        logger.info({
            oldShards,
            newShards
        }, 'Shard configuration changed - service will adapt automatically');

        // The service automatically adapts to shard changes since we query
        // shard info on each processing cycle. No special handling needed.
    }

    /**
     * Cleanup old active calls that may have missed webhooks
     */
    async cleanupOldCalls() {
        try {
            this.retellClient.cleanupOldCalls(30 * 60 * 1000); // 30 minutes
        } catch (error) {
            logger.error({ err: error }, 'Error during call cleanup');
        }
    }

    /**
     * Setup signal handlers for graceful shutdown
     */
    setupSignalHandlers() {
        const signals = ['SIGTERM', 'SIGINT'];

        signals.forEach(signal => {
            process.on(signal, async () => {
                logger.info({ signal }, 'Received shutdown signal');
                await this.shutdown();
                process.exit(0);
            });
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error({ err: error }, 'Uncaught exception');
            this.shutdown().then(() => process.exit(1));
        });

        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            logger.error({ reason, promise }, 'Unhandled promise rejection');
            this.shutdown().then(() => process.exit(1));
        });
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        this.isShuttingDown = true;
        logger.info('Starting graceful shutdown...');

        try {
            // Stop processing loops
            if (this.processingInterval) {
                clearInterval(this.processingInterval);
                this.processingInterval = null;
            }

            if (this.odooProcessingInterval) {
                clearInterval(this.odooProcessingInterval);
                this.odooProcessingInterval = null;
            }

            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
                this.cleanupInterval = null;
            }

            // Stop shard monitoring
            if (this.stopShardMonitoring) {
                this.stopShardMonitoring();
            }

            // Stop HTTP server
            if (this.httpServer) {
                await this.httpServer.stop();
            }

            // Close database connections
            if (this.dbClient) {
                await this.dbClient.close();
            }

            logger.info('Graceful shutdown completed');

        } catch (error) {
            logger.error({ err: error }, 'Error during shutdown');
        }
    }
}

// Start the service if this file is run directly
if (require.main === module) {
    const processor = new RetellCaller();
    processor.start().catch((error) => {
        logger.error({ err: error }, 'Failed to start Retell Caller service');
        process.exit(1);
    });
}

module.exports = RetellCaller;