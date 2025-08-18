const { Pool } = require('pg');
const logger = require('./logger');

class DatabaseClient {
    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT, 10),
            database: process.env.DB_NAME,
            user: process.env.POSTGRES_USER,
            password: process.env.POSTGRES_PASSWORD,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            statement_timeout: 30000,
            query_timeout: 30000,
        });

        this.pool.on('error', (err) => {
            logger.error({ err }, 'Unexpected error on idle client');
        });

        this.tableName = process.env.DB_TABLE_NAME || 'survey_responses';
    }

    async healthCheck() {
        try {
            const client = await this.pool.connect();
            await client.query('SELECT 1');
            client.release();
            return true;
        } catch (error) {
            logger.error({ err: error }, 'Database health check failed');
            return false;
        }
    }

    /**
     * Get the next eligible survey response for processing with sharding and row locking
     * @param {number} shardIndex - 1-based shard index for this pod
     * @param {number} totalShards - Total number of shards (pods)
     * @returns {Promise<Object|null>} Survey response row or null if none available
     */
    async getNextSurveyResponse(shardIndex, totalShards, activeSurveys) {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Query with sharding logic and row locking
            const query = `
        SELECT
          sr.id                     AS survey_id,
          sr.customer_id,
          c.name                    AS customer_name,
          c.email                   AS client_email,
          c.phone_number            AS client_phone_number,
          sr.business_type,
          sr.employee_count,
          sr.revenue,
          sr.operational_frustration,
          sr.time_consuming_tasks,
          sr.inefficiencies,
          sr.automation_area,
          sr.one_task_to_automate,
          sr.hours_to_save,
          sr.growth_obstacle,
          sr.important_outcome,
          sr.created_at             AS survey_date,
          EXTRACT(
            DAY FROM (NOW() - sr.created_at)
          )                         AS days_since_survey
        FROM survey_responses sr
        JOIN customers c
          ON c.id = sr.customer_id
        WHERE
          c.phone_number IS NOT NULL
          AND c.phone_number <> ''
          AND sr.processed IS NOT TRUE
          AND sr.data_sent_to_retell IS NOT TRUE
          AND c.phone_number_validated IS TRUE
          AND (sr.id % $2) = ($1 - 1)
          AND sr.id <> ALL($3::int[]) 
        ORDER BY
          CASE
            WHEN sr.operational_frustration ILIKE '%extremely%'  THEN 1
            WHEN sr.operational_frustration ILIKE '%very%'       THEN 2
            WHEN sr.operational_frustration ILIKE '%frustrated%' THEN 3
            ELSE 4
          END,
          sr.created_at DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
            const activeSurveyIds = [...activeSurveys.keys()]
                .filter((x) => Number.isInteger(x)); // also removes null/undefined
            const result = await client.query(query, [shardIndex, totalShards, activeSurveyIds]);

            await client.query('COMMIT');

            if (result.rows.length === 0) {
                logger.debug({ shardIndex, totalShards }, 'No eligible survey responses found for this shard');
                return null;
            }

            const row = result.rows[0];
            // const rows = result.rows;
            // logger.info('Retrieved surveys response for processing ', len(rows));

            return row;

        } catch (error) {
            await client.query('ROLLBACK');
            logger.error({
                err: error,
                shardIndex,
                totalShards
            }, 'Failed to get next survey response');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Mark a survey response as sent to Retell
     * @param {number} surveyId - The survey response ID
     * @returns {Promise<boolean>} Success status
     */
    // async markAsSentToRetell(surveyId) {
    //     const client = await this.pool.connect();

    //     try {
    //         const query = `
    //     UPDATE ${this.tableName} 
    //     SET data_sent_to_retell = TRUE, updated_at = NOW() 
    //     WHERE id = $1
    //   `;

    //         const result = await client.query(query, [surveyId]);

    //         if (result.rowCount === 0) {
    //             logger.warn({ surveyId }, 'No rows updated when marking as sent to Retell');
    //             return false;
    //         }

    //         logger.info({ surveyId }, 'Marked survey response as sent to Retell');
    //         return true;

    //     } catch (error) {
    //         logger.error({
    //             err: error,
    //             surveyId
    //         }, 'Failed to mark survey response as sent to Retell');
    //         throw error;
    //     } finally {
    //         client.release();
    //     }
    // }

    /**
     * Get survey response by ID for webhook processing
     * @param {number} surveyId - The survey response ID
     * @returns {Promise<Object|null>} Survey response row or null if not found
     */
    async getSurveyResponseById(surveyId) {
        try {
            const query = `
        SELECT id, customer_id, data_sent_to_retell, processed
        FROM ${this.tableName}
        WHERE id = $1
      `;

            const result = await this.pool.query(query, [surveyId]);

            if (result.rows.length === 0) {
                return null;
            }

            return result.rows[0];

        } catch (error) {
            logger.error({
                err: error,
                surveyId
            }, 'Failed to get survey response by ID');
            throw error;
        }
    }

    /**
     * Retry mechanism with exponential backoff
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

                // Don't retry on certain types of errors
                if (error.code === '23505' || error.code === '23503') { // Unique violation, foreign key violation
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
                }, 'Database operation failed, retrying');

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    async close() {
        await this.pool.end();
        logger.info('Database connection pool closed');
    }
}

module.exports = DatabaseClient;