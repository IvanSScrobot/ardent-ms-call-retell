const axios = require('axios');
const logger = require('./logger');

class OdooService {
    constructor() {
        const odooUrlRaw = process.env.ODOO_URL;
        this.odooUrl = (odooUrlRaw || '').replace(/\/+$/, '');
        this.odooDatabase = process.env.ODOO_DATABASE;
        this.odooUsername = process.env.ODOO_USERNAME;
        this.odooApiKey = process.env.ODOO_API_KEY;
        this.sessionId = null;

        // Validate required environment variables
        this.validateEnvironmentVariables();

        this.http = axios.create({
            baseURL: this.odooUrl,
            headers: { 'Content-Type': 'application/json' },
            timeout: 150000,
            // no cookies needed for pure JSON-RPC with uid/password
            withCredentials: false
        });
    }

    /**
     * Validate that all required Odoo environment variables are set
     */
    validateEnvironmentVariables() {
        const requiredVars = [
            { name: 'ODOO_URL', value: this.odooUrl },
            { name: 'ODOO_DATABASE', value: this.odooDatabase },
            { name: 'ODOO_USERNAME', value: this.odooUsername },
            { name: 'ODOO_API_KEY', value: this.odooApiKey }
        ];

        const missingVars = requiredVars.filter(envVar => !envVar.value || envVar.value.trim() === '');

        if (missingVars.length > 0) {
            const missingVarNames = missingVars.map(envVar => envVar.name).join(', ');
            const errorMessage = `Missing required Odoo environment variables: ${missingVarNames}`;

            logger.error('Odoo service initialization failed', {
                missingVariables: missingVarNames,
                error: errorMessage
            });

            throw new Error(errorMessage);
        }

        logger.info('Odoo environment variables validated successfully', {
            odooUrl: this.odooUrl,
            database: this.odooDatabase,
            apiKeyPresent: !!this.odooApiKey
        });
    }

    /**
   * Low-level JSON-RPC helper
   */
    async rpcCall({ service, method, args = [], kwargs = {} }) {
        const payload = {
            jsonrpc: '2.0',
            method: 'call',
            params: { service, method, args, kwargs },
            id: Math.floor(Math.random() * 1_000_000)
        };
        const { data } = await this.http.post('/jsonrpc', payload);
        if (data?.error) {
            const { message, data: errData } = data.error;
            const details = errData?.message || errData?.debug || JSON.stringify(data.error);
            throw new Error(`${message}${details ? ` | ${details}` : ''}`);
        }
        return data.result;
    }

    /**
     * Authenticate with Odoo server
     */
    async authenticate() {
        try {
            logger.info('Authenticating with Odoo server', {
                odooUrl: this.odooUrl,
                database: this.odooDatabase,
                username: this.odooUsername
            });

            const result = await this.rpcCall({
                service: 'common',
                method: 'authenticate',
                args: [this.odooDatabase, this.odooUsername, this.odooApiKey, {}]
            });

            // authenticate returns uid (number) or false
            if (!result || typeof result !== 'number') {
                throw new Error('Invalid credentials or authentication failed (uid not returned)');
            }

            this.uid = result;

            logger.info('Odoo authentication successful', {
                uid: this.uid ? 'present' : 'missing'
            });

            return this.uid;
        } catch (error) {
            logger.error('Odoo authentication failed', {
                error: error.message,
                stack: error.stack,
                odooUrl: this.odooUrl
            });
            throw new Error(`Failed to authenticate with Odoo: ${error.message}`);
        }
    }


    /**
   * Execute a model method (execute_kw) via JSON-RPC
   * Always passes db, uid, ApiKey
   */
    async executeKw(model, method, args = [], kwargs = {}) {
        // if (!this.uid) {
        await this.authenticate();
        // }
        return this.rpcCall({
            service: 'object',
            method: 'execute_kw',
            args: [this.odooDatabase, this.uid, this.odooApiKey, model, method, args, kwargs]
        });
    }

    /**
     * Create a new lead in Odoo CRM
     */
    async createLead(leadData) {
        try {
            logger.info('Creating new lead in Odoo CRM', {
                customerName: leadData.customerName,
                surveyId: leadData.surveyId
            });

            const values = {
                name: `Survey Lead - ${leadData.customerName}`,
                partner_name: leadData.customerName,
                phone: leadData.phone,
                email_from: leadData.email,
                description: `${leadData.summary || ''}\n\nsurvey_id: ${leadData.surveyId}`,
                source_id: 2, // Default source, adjust as needed
                campaign_id: 1,  // Default campaign, adjust as needed
                user_id: 1,   // Default user, adjust as needed
                team_id: 1    // Default team, adjust as needed
            };

            const leadId = await this.executeKw('crm.lead', 'create', [values]);

            logger.info('Lead created successfully in Odoo', {
                leadId,
                customerName: leadData.customerName,
                surveyId: leadData.surveyId
            });

            return {
                success: true,
                leadId,
                customerName: leadData.customerName,
                surveyId: leadData.surveyId
            };

        } catch (error) {
            logger.error('Failed to create lead in Odoo', {
                error: error.message,
                stack: error.stack,
                customerName: leadData.customerName,
                surveyId: leadData.surveyId
            });
            throw new Error(`Failed to create Odoo lead: ${error.message}`);
        }
    }

    /**
     * Health check for Odoo connection
     */
    async healthCheck() {
        try {
            logger.debug('Performing Odoo health check');
            const version = await this.rpcCall({
                service: 'common',
                method: 'version',
                args: []
            });
            return {
                status: 'healthy',
                version,
                timestamp: new Date().toISOString()
            };
        }
        catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}

module.exports = OdooService;