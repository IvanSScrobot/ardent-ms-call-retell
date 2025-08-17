const k8s = require('@kubernetes/client-node');
const logger = require('./logger');

class ShardingManager {
    constructor() {
        this.kc = new k8s.KubeConfig();

        // Load config from cluster or local kubeconfig
        if (process.env.KUBERNETES_SERVICE_HOST) {
            this.kc.loadFromCluster();
        } else {
            this.kc.loadFromDefault();
        }

        this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);

        this.podName = process.env.POD_NAME;
        this.podNamespace = process.env.POD_NAMESPACE || 'default';
        this.daemonSetName = process.env.DAEMONSET_NAME || 'retell-caller';

        // Cache shard info to avoid frequent API calls
        this.shardInfo = null;
        this.lastShardUpdate = null;
        this.shardCacheTtl = 60000; // 1 minute cache
    }

    /**
     * Get the current pod's shard index and total shard count
     * @returns {Promise<{shardIndex: number, totalShards: number}>}
     */
    async getShardInfo() {
        const now = Date.now();

        // Return cached info if still valid
        if (this.shardInfo && this.lastShardUpdate && (now - this.lastShardUpdate) < this.shardCacheTtl) {
            return this.shardInfo;
        }

        try {
            // Get all pods for this DaemonSet
            const labelSelector = `app=${this.daemonSetName}`;
            const podsResponse = await this.k8sApi.listNamespacedPod(
                this.podNamespace,
                undefined, // pretty
                undefined, // allowWatchBookmarks
                undefined, // continue
                undefined, // fieldSelector
                labelSelector
            );

            const pods = podsResponse.body.items
                .filter(pod => pod.status.phase === 'Running')
                .map(pod => pod.metadata.name)
                .sort(); // Stable sort for consistent ordering

            const totalShards = pods.length;
            const shardIndex = pods.indexOf(this.podName) + 1; // 1-based index

            if (shardIndex === 0) {
                throw new Error(`Current pod ${this.podName} not found in running pods list`);
            }

            this.shardInfo = { shardIndex, totalShards };
            this.lastShardUpdate = now;

            logger.info({
                podName: this.podName,
                shardIndex,
                totalShards,
                allPods: pods
            }, 'Updated shard information');

            return this.shardInfo;

        } catch (error) {
            logger.error({
                err: error,
                podName: this.podName,
                namespace: this.podNamespace
            }, 'Failed to get shard information');

            // If we have cached info, return it as fallback
            if (this.shardInfo) {
                logger.warn('Using cached shard info due to API error');
                return this.shardInfo;
            }

            throw error;
        }
    }

    /**
     * Check if a given ID should be processed by this shard
     * @param {number} id - The ID to check (e.g., survey response ID)
     * @param {number} shardIndex - 1-based shard index
     * @param {number} totalShards - Total number of shards
     * @returns {boolean} True if this shard should process the ID
     */
    static shouldProcessId(id, shardIndex, totalShards) {
        // Convert to 0-based for modulo calculation
        const zeroBasedIndex = shardIndex - 1;
        return (id % totalShards) === zeroBasedIndex;
    }

    /**
     * Get shard statistics for monitoring
     * @returns {Promise<Object>} Shard statistics
     */
    async getShardStats() {
        try {
            const { shardIndex, totalShards } = await this.getShardInfo();

            return {
                podName: this.podName,
                namespace: this.podNamespace,
                shardIndex,
                totalShards,
                shardPercentage: (100 / totalShards).toFixed(2),
                lastUpdated: this.lastShardUpdate
            };
        } catch (error) {
            logger.error({ err: error }, 'Failed to get shard statistics');
            return {
                error: error.message,
                podName: this.podName,
                namespace: this.podNamespace
            };
        }
    }

    /**
     * Validate shard configuration
     * @returns {Promise<boolean>} True if configuration is valid
     */
    async validateShardConfig() {
        try {
            if (!this.podName) {
                logger.error('POD_NAME environment variable not set');
                return false;
            }

            const { shardIndex, totalShards } = await this.getShardInfo();

            if (shardIndex < 1 || shardIndex > totalShards) {
                logger.error({
                    shardIndex,
                    totalShards
                }, 'Invalid shard index');
                return false;
            }

            if (totalShards < 1) {
                logger.error({ totalShards }, 'Invalid total shards count');
                return false;
            }

            logger.info({
                shardIndex,
                totalShards
            }, 'Shard configuration validated successfully');

            return true;

        } catch (error) {
            logger.error({ err: error }, 'Failed to validate shard configuration');
            return false;
        }
    }

    /**
     * Monitor for shard changes (pod additions/removals)
     * @param {Function} callback - Callback to execute when shards change
     * @param {number} interval - Check interval in milliseconds
     */
    startShardMonitoring(callback, interval = 30000) {
        let lastTotalShards = null;

        const checkShards = async () => {
            try {
                const { totalShards } = await this.getShardInfo();

                if (lastTotalShards !== null && lastTotalShards !== totalShards) {
                    logger.info({
                        oldShards: lastTotalShards,
                        newShards: totalShards
                    }, 'Shard count changed');

                    if (callback) {
                        await callback({ oldShards: lastTotalShards, newShards: totalShards });
                    }
                }

                lastTotalShards = totalShards;

            } catch (error) {
                logger.error({ err: error }, 'Error during shard monitoring');
            }
        };

        // Initial check
        checkShards();

        // Set up periodic monitoring
        const monitoringInterval = setInterval(checkShards, interval);

        logger.info({ interval }, 'Started shard monitoring');

        return () => {
            clearInterval(monitoringInterval);
            logger.info('Stopped shard monitoring');
        };
    }

    /**
     * Get example IDs that this shard would process
     * @param {number} maxExamples - Maximum number of examples to return
     * @returns {Promise<number[]>} Array of example IDs
     */
    async getExampleIds(maxExamples = 10) {
        try {
            const { shardIndex, totalShards } = await this.getShardInfo();
            const examples = [];

            for (let i = 1; i <= maxExamples * totalShards; i++) {
                if (ShardingManager.shouldProcessId(i, shardIndex, totalShards)) {
                    examples.push(i);
                    if (examples.length >= maxExamples) break;
                }
            }

            return examples;
        } catch (error) {
            logger.error({ err: error }, 'Failed to generate example IDs');
            return [];
        }
    }
}

module.exports = ShardingManager;