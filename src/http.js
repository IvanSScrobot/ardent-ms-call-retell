const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('./logger');

class HttpServer {
    constructor(dbClient, retellClient, shardingManager) {
        this.app = express();
        this.dbClient = dbClient;
        this.retellClient = retellClient;
        this.shardingManager = shardingManager;
        this.server = null;

        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    setupMiddleware() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: false, // Disable CSP for API service
        }));

        // CORS
        this.app.use(cors({
            origin: process.env.CORS_ORIGIN || false,
            credentials: true
        }));

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Request logging
        this.app.use((req, res, next) => {
            const start = Date.now();

            res.on('finish', () => {
                const duration = Date.now() - start;
                logger.info({
                    method: req.method,
                    url: req.url,
                    statusCode: res.statusCode,
                    duration,
                    userAgent: req.get('User-Agent'),
                    ip: req.ip
                }, 'HTTP request completed');
            });

            next();
        });
    }

    setupRoutes() {
        // Health check endpoints
        this.app.get('/healthz', this.healthCheck.bind(this));
        this.app.get('/readyz', this.readinessCheck.bind(this));

        // Metrics and status endpoints
        this.app.get('/status', this.statusCheck.bind(this));
        this.app.get('/metrics', this.metricsEndpoint.bind(this));

        // Retell webhook endpoint
        // this.app.post('/retell/webhook', this.handleRetellWebhook.bind(this));

        // Debug endpoints (only in development)
        if (process.env.NODE_ENV === 'development') {
            this.app.get('/debug/shard', this.debugShard.bind(this));
            this.app.get('/debug/calls', this.debugCalls.bind(this));
        }
    }

    setupErrorHandling() {
        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Not Found',
                message: `Route ${req.method} ${req.path} not found`
            });
        });

        // Global error handler
        this.app.use((err, req, res, next) => {
            logger.error({
                err,
                method: req.method,
                url: req.url,
                body: req.body
            }, 'Unhandled error in HTTP request');

            res.status(500).json({
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
            });
        });
    }

    /**
     * Liveness probe - checks if the application is running
     */
    async healthCheck(req, res) {
        try {
            const health = {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                pid: process.pid
            };

            res.status(200).json(health);
        } catch (error) {
            logger.error({ err: error }, 'Health check failed');
            res.status(503).json({
                status: 'unhealthy',
                error: error.message
            });
        }
    }

    /**
     * Readiness probe - checks if the application is ready to serve traffic
     */
    async readinessCheck(req, res) {
        try {
            // Check database connectivity
            const dbHealthy = await this.dbClient.healthCheck();

            // Check shard configuration
            const shardValid = await this.shardingManager.validateShardConfig();

            const ready = dbHealthy && shardValid;

            const readiness = {
                status: ready ? 'ready' : 'not ready',
                timestamp: new Date().toISOString(),
                checks: {
                    database: dbHealthy ? 'healthy' : 'unhealthy',
                    sharding: shardValid ? 'valid' : 'invalid'
                }
            };

            res.status(ready ? 200 : 503).json(readiness);
        } catch (error) {
            logger.error({ err: error }, 'Readiness check failed');
            res.status(503).json({
                status: 'not ready',
                error: error.message
            });
        }
    }

    /**
     * Status endpoint with detailed service information
     */
    async statusCheck(req, res) {
        try {
            const shardStats = await this.shardingManager.getShardStats();
            const activeCallsCount = this.retellClient.getActiveCallsCount();

            const status = {
                service: 'retell-processor',
                version: process.env.npm_package_version || '1.0.0',
                environment: process.env.NODE_ENV || 'production',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                shard: shardStats,
                activeCalls: activeCallsCount,
                memory: process.memoryUsage(),
                config: {
                    scanInterval: process.env.SCAN_INTERVAL_MS || 10000,
                    dbHost: process.env.DB_HOST,
                    dbName: process.env.DB_NAME,
                    retellFromNumber: process.env.RETELL_FROM_NUMBER || '+17787691188'
                }
            };

            res.status(200).json(status);
        } catch (error) {
            logger.error({ err: error }, 'Status check failed');
            res.status(500).json({
                error: 'Failed to get status',
                message: error.message
            });
        }
    }

    /**
     * Metrics endpoint for monitoring
     */
    async metricsEndpoint(req, res) {
        try {
            const shardStats = await this.shardingManager.getShardStats();
            const activeCallsCount = this.retellClient.getActiveCallsCount();
            const memUsage = process.memoryUsage();

            // Simple text metrics format
            const metrics = [
                `# HELP retell_processor_uptime_seconds Process uptime in seconds`,
                `# TYPE retell_processor_uptime_seconds gauge`,
                `retell_processor_uptime_seconds ${process.uptime()}`,
                ``,
                `# HELP retell_processor_active_calls Number of active Retell calls`,
                `# TYPE retell_processor_active_calls gauge`,
                `retell_processor_active_calls ${activeCallsCount}`,
                ``,
                `# HELP retell_processor_shard_index Current shard index`,
                `# TYPE retell_processor_shard_index gauge`,
                `retell_processor_shard_index ${shardStats.shardIndex || 0}`,
                ``,
                `# HELP retell_processor_total_shards Total number of shards`,
                `# TYPE retell_processor_total_shards gauge`,
                `retell_processor_total_shards ${shardStats.totalShards || 0}`,
                ``,
                `# HELP retell_processor_memory_usage_bytes Memory usage in bytes`,
                `# TYPE retell_processor_memory_usage_bytes gauge`,
                `retell_processor_memory_usage_bytes{type="rss"} ${memUsage.rss}`,
                `retell_processor_memory_usage_bytes{type="heapUsed"} ${memUsage.heapUsed}`,
                `retell_processor_memory_usage_bytes{type="heapTotal"} ${memUsage.heapTotal}`,
                ``
            ].join('\n');

            res.set('Content-Type', 'text/plain');
            res.status(200).send(metrics);
        } catch (error) {
            logger.error({ err: error }, 'Metrics endpoint failed');
            res.status(500).json({
                error: 'Failed to get metrics',
                message: error.message
            });
        }
    }

    /**
     * Handle Retell webhook for call completion
     */
    // async handleRetellWebhook(req, res) {
    //     try {
    //         const webhookPayload = req.body;

    //         logger.info({
    //             event: webhookPayload.event,
    //             callId: webhookPayload.call?.call_id,
    //             surveyId: webhookPayload.call?.metadata?.survey_id
    //         }, 'Received Retell webhook');

    //         // Process the webhook
    //         const result = await this.retellClient.handleWebhook(webhookPayload);

    //         if (result.success && result.surveyId && webhookPayload.event === 'call_ended') {
    //             // Mark the survey response as sent to Retell
    //             const updated = await this.dbClient.markAsSentToRetell(result.surveyId);

    //             if (updated) {
    //                 logger.info({
    //                     surveyId: result.surveyId,
    //                     callId: result.callId
    //                 }, 'Successfully processed call completion webhook');
    //             } else {
    //                 logger.warn({
    //                     surveyId: result.surveyId,
    //                     callId: result.callId
    //                 }, 'Failed to update survey response after call completion');
    //             }
    //         }

    //         res.status(200).json({ received: true, processed: result.success });

    //     } catch (error) {
    //         logger.error({
    //             err: error,
    //             body: req.body
    //         }, 'Failed to handle Retell webhook');

    //         res.status(500).json({
    //             error: 'Failed to process webhook',
    //             message: error.message
    //         });
    //     }
    // }

    /**
     * Debug endpoint for shard information (development only)
     */
    async debugShard(req, res) {
        try {
            const shardStats = await this.shardingManager.getShardStats();
            const exampleIds = await this.shardingManager.getExampleIds(20);

            res.status(200).json({
                shard: shardStats,
                exampleIds,
                shouldProcess: {
                    id1: this.shardingManager.constructor.shouldProcessId(1, shardStats.shardIndex, shardStats.totalShards),
                    id10: this.shardingManager.constructor.shouldProcessId(10, shardStats.shardIndex, shardStats.totalShards),
                    id100: this.shardingManager.constructor.shouldProcessId(100, shardStats.shardIndex, shardStats.totalShards)
                }
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * Debug endpoint for active calls (development only)
     */
    async debugCalls(req, res) {
        try {
            const activeCallsCount = this.retellClient.getActiveCallsCount();

            res.status(200).json({
                activeCallsCount,
                // Don't expose actual call data for privacy
                message: 'Active calls are being tracked internally'
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * Start the HTTP server
     */
    async start(port = process.env.PORT || 3000) {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(port, (err) => {
                if (err) {
                    logger.error({ err, port }, 'Failed to start HTTP server for Caller');
                    reject(err);
                } else {
                    logger.info({ port }, 'Caller HTTP server started successfully');
                    resolve();
                }
            });
        });
    }

    /**
     * Stop the HTTP server gracefully
     */
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    logger.info('HTTP server stopped');
                    resolve();
                });
            });
        }
    }
}

module.exports = HttpServer;