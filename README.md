# Retell Processor

A production-ready Kubernetes microservice that processes survey responses by initiating outbound phone calls through Retell AI. The service is designed to run as a DaemonSet with automatic sharding across multiple nodes.

## Overview

This microservice:
- Periodically queries PostgreSQL for unprocessed survey responses
- Creates outbound phone calls via Retell AI API for each survey response
- Supports multiple concurrent instances with automatic sharding
- Handles call completion via webhooks and updates the database accordingly
- Provides comprehensive health checks, metrics, and observability

## Architecture

### Components

- **Database Client** (`src/db.js`) - PostgreSQL connection with sharding-aware queries
- **Retell Client** (`src/retell.js`) - Retell AI API integration with webhook handling
- **Sharding Manager** (`src/sharding.js`) - Kubernetes-aware pod coordination
- **HTTP Server** (`src/http.js`) - Health checks, metrics, and webhook endpoints
- **Main Service** (`src/index.js`) - Orchestrates all components with graceful lifecycle management

### Sharding Strategy

The service uses a deterministic sharding approach:
1. Each pod discovers its position in the DaemonSet by listing pods via Kubernetes API
2. Pods are sorted by name to ensure consistent ordering
3. Each pod processes survey responses where `survey_id % total_pods === pod_index`
4. Database queries use `SELECT ... FOR UPDATE SKIP LOCKED` to prevent race conditions

### Asynchronous Call Processing

Retell AI calls are processed asynchronously:
1. Service creates a call via Retell API (returns immediately)
2. Call correlation is stored locally using `survey_id` in metadata
3. When call completes, Retell sends webhook to `/retell/webhook`
4. Webhook handler updates database to mark survey as processed

## Configuration

### Environment Variables

#### Required
- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port
- `DB_NAME` - Database name
- `POSTGRES_USER` - Database username (from Secret)
- `POSTGRES_PASSWORD` - Database password (from Secret)
- `RETELL_API_KEY` - Retell AI API key (from Secret)
- `POD_NAME` - Current pod name (from Downward API)

#### Optional
- `DB_TABLE_NAME` - Table name (default: `survey_responses`)
- `POD_NAMESPACE` - Pod namespace (default: `default`)
- `SCAN_INTERVAL_MS` - Processing interval (default: `10000`)
- `CLEANUP_INTERVAL_MS` - Call cleanup interval (default: `300000`)
- `PORT` - HTTP server port (default: `3000`)
- `NODE_ENV` - Environment (default: `production`)
- `LOG_LEVEL` - Logging level (default: `info`)
- `RETELL_FROM_NUMBER` - Caller ID (default: `+17787691188`)
- `RETELL_AGENT_ID` - Retell agent ID (default: `agent_826371748c85ca36277cae28c2`)

## Local Development

### Prerequisites
- Node.js 20+
- PostgreSQL database with survey data
- Retell AI API key

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Set up database:**
   Ensure your PostgreSQL database has the required tables:
   - `survey_responses` - Main survey data
   - `customers` - Customer information with phone numbers

4. **Run locally:**
   ```bash
   # Development mode with auto-reload
   npm run dev
   
   # Production mode
   npm start
   ```

### Local Testing

The service exposes several endpoints for testing:

- `GET /healthz` - Liveness probe
- `GET /readyz` - Readiness probe  
- `GET /status` - Detailed service status
- `GET /metrics` - Prometheus-style metrics
- `POST /retell/webhook` - Retell webhook endpoint

In development mode, additional debug endpoints are available:
- `GET /debug/shard` - Shard configuration details
- `GET /debug/calls` - Active calls information

### Webhook Testing

To test webhooks locally, you can use tools like ngrok:

```bash
# Expose local service
ngrok http 3000

# Configure Retell webhook URL to point to:
# https://your-ngrok-url.ngrok.io/retell/webhook
```

## Docker

### Building

```bash
# Build the image
docker build -t retell-caller .

# Run locally with environment file
docker run --env-file .env -p 3000:3000 retell-caller
```

### Multi-stage Build

The Dockerfile uses a multi-stage build for optimal image size and security:
- Builder stage installs dependencies
- Production stage runs as non-root user with minimal attack surface

## Kubernetes Deployment

### Prerequisites

1. **Existing PostgreSQL Secret:**
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: postgres-credentials
   data:
     POSTGRES_USER: <base64-encoded-username>
     POSTGRES_PASSWORD: <base64-encoded-password>
   ```

2. **Update Retell API Key:**
   Edit `k8s.yaml` and replace the base64-encoded Retell API key:
   ```bash
   echo -n "your_actual_retell_api_key" | base64
   ```

### Deployment

```bash
# Deploy all resources
kubectl apply -f k8s.yaml

# Check deployment status
kubectl get daemonset retell-caller
kubectl get pods -l app=retell-caller

# View logs
kubectl logs -l app=retell-caller -f

# Check service health
kubectl port-forward svc/retell-caller-service 3000:3000
curl http://localhost:3000/healthz
```

### Scaling

The DaemonSet automatically scales with your cluster:
- Adding nodes automatically creates new pods
- Removing nodes gracefully terminates pods
- Sharding automatically rebalances across available pods

### Monitoring

The service provides comprehensive observability:

1. **Health Checks:**
   - Liveness: `/healthz` - Basic service health
   - Readiness: `/readyz` - Database connectivity and shard validation

2. **Metrics:** `/metrics` - Prometheus-compatible metrics including:
   - Service uptime
   - Active call count
   - Shard information
   - Memory usage

3. **Structured Logging:**
   - JSON format in production
   - Contextual information (shard index, survey IDs, call IDs)
   - PII redaction for security

## Database Schema

The service expects the following PostgreSQL schema:

### survey_responses table
```sql
CREATE TABLE survey_responses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER,
  business_type VARCHAR(255),
  employee_count VARCHAR(50),
  revenue VARCHAR(50),
  operational_frustration TEXT,
  time_consuming_tasks TEXT,
  inefficiencies TEXT,
  automation_area TEXT,
  one_task_to_automate TEXT,
  hours_to_save VARCHAR(50),
  growth_obstacle TEXT,
  important_outcome VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  processed BOOLEAN,
  call_summary TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
  //data_sent_to_retell BOOLEAN
);
```

### customers table
```sql
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  email VARCHAR(255),
  phone_number VARCHAR(50),
  phone_number_validated BOOLEAN
);
```

## Retell Integration

### Call Creation

The service creates calls with the following payload structure:

```javascript
{
  "from_number": "+17787691188",
  "to_number": "customer_phone_number",
  "retell_llm_dynamic_variables": {
    "name": "customer_name",
    "phone_number": "customer_phone_number", 
    "email": "customer_email",
    "service": "business_type",
    "budget": "revenue",
    "frustration": "operational_frustration",
    "inefficiencies": "inefficiencies",
    "priority_automation": "one_task_to_automate",
    "important_outcome": "important_outcome",
    "survey_date": "survey_date"
  },
  "metadata": {
    "survey_id": "survey_response_id"
  },
  "override_agent_id": "agent_826371748c85ca36277cae28c2"
}
```

### Webhook Handling

Another service called 'ms-ardent-processor' handles `call_ended` webhooks from Retell:

```javascript
{
  "event": "call_ended",
  "call": {
    "call_id": "unique_call_id",
    "call_status": "completed",
    "disconnection_reason": "user_hangup",
    "transcript": "call_transcript",
    "metadata": {
      "survey_id": "original_survey_id"
    }
  }
}
```

## Error Handling

The service implements comprehensive error handling:

### Database Errors
- Connection failures: Exponential backoff with jitter
- Query timeouts: Configurable timeout with retries
- Lock conflicts: `SKIP LOCKED` prevents blocking

### Retell API Errors
- Rate limiting (429): Exponential backoff
- Temporary failures (5xx): Retry with backoff
- Permanent failures (4xx): Log and skip

### Kubernetes Errors
- Pod listing failures: Cached shard info fallback
- API server unavailable: Continue with last known configuration

## Security

### Container Security
- Runs as non-root user (UID 1001)
- Read-only root filesystem
- Dropped Linux capabilities
- Security context enforcement

### Network Security
- NetworkPolicy restricts ingress/egress
- TLS for all external communications
- Secrets management for sensitive data

### Data Protection
- PII redaction in logs
- Parameterized SQL queries
- Input validation and sanitization

## Operational Guidance

### Scaling Considerations

1. **Horizontal Scaling:**
   - DaemonSet automatically scales with cluster nodes
   - Each node runs exactly one pod
   - Sharding rebalances automatically

2. **Vertical Scaling:**
   - Adjust resource requests/limits in DaemonSet
   - Monitor memory usage via `/metrics`
   - CPU usage typically low except during call creation

### Rollout Strategy

1. **Rolling Updates:**
   - DaemonSet uses `RollingUpdate` strategy
   - `maxUnavailable: 1` ensures availability
   - PodDisruptionBudget protects against disruptions

2. **Blue-Green Deployment:**
   - Not recommended for DaemonSet
   - Use rolling updates for gradual rollout

### Common Failure Modes

1. **Database Connection Issues:**
   - Check PostgreSQL service health
   - Verify network connectivity
   - Review connection pool settings

2. **Retell API Failures:**
   - Verify API key validity
   - Check rate limiting
   - Monitor webhook delivery

3. **Sharding Problems:**
   - Ensure RBAC permissions for pod listing
   - Check pod naming consistency
   - Verify Downward API configuration

4. **Webhook Delivery Issues:**
   - Confirm service accessibility
   - Check NetworkPolicy rules
   - Verify Retell webhook configuration

### Replaying Failed Rows

To replay failed survey responses:

1. **Reset processing flags:**
   ```sql
   UPDATE survey_responses 
   SET processed = FALSE 
   WHERE id IN (failed_survey_ids);
   ```

2. **Monitor processing:**
   ```bash
   kubectl logs -l app=retell-caller -f | grep "survey_id"
   ```

### Monitoring and Alerting

Recommended alerts:

1. **Service Health:**
   - Pod crash loops
   - Failed health checks
   - High memory usage

2. **Processing Issues:**
   - No surveys processed in X minutes
   - High error rates
   - Webhook delivery failures

3. **Database Issues:**
   - Connection failures
   - Query timeouts
   - Lock contention

## Troubleshooting

### Debug Commands

```bash
# Check pod status
kubectl get pods -l app=retell-caller -o wide

# View detailed pod information
kubectl describe pod <pod-name>

# Check logs
kubectl logs <pod-name> -f

# Execute commands in pod
kubectl exec -it <pod-name> -- /bin/sh

# Check service endpoints
kubectl get endpoints retell-caller-service

# Test connectivity
kubectl run debug --image=busybox -it --rm -- wget -qO- http://retell-caller-service:3000/healthz
```

### Common Issues

1. **Pod not starting:**
   - Check image availability
   - Verify resource limits
   - Review security context

2. **Database connection failed:**
   - Verify secret exists and is correct
   - Check network policies
   - Test database connectivity

3. **Sharding not working:**
   - Ensure ServiceAccount has pod list permissions
   - Check RBAC configuration
   - Verify pod naming

4. **Webhooks not received:**
   - Confirm service is accessible
   - Check Retell webhook configuration
   - Verify network policies

## Contributing

1. Follow the existing code structure
2. Add comprehensive error handling
3. Include structured logging
4. Write tests for new functionality
5. Update documentation
