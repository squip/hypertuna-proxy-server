// Hypertuna Proxy Server 

const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const net = require('net');
const WebSocket = require('ws');
const url = require('url');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Hyperswarm = require('hyperswarm');
const Hyperdrive = require('hyperdrive');
const Localdrive = require('localdrive');
const Corestore = require('corestore');
const LocalWSSServer = require('./local-wss');
const debounce = require('debounceify');
const b4a = require('b4a');
const stdio = require('pear-stdio');

// ============================
// Core Classes
// ============================

class PeerHealthManager {
  constructor(cleanupThreshold = 5 * 60 * 1000) {
    this.healthChecks = new Map();
    this.checkLocks = new Map();
    this.failureCount = new Map();
    this.cleanupThreshold = cleanupThreshold;
    this.circuitBreakerThreshold = 3;
    this.circuitBreakerTimeout = 5 * 60 * 1000;
    this.metrics = {
      totalChecks: 0,
      failedChecks: 0,
      recoveredPeers: 0,
      lastMetricsReset: Date.now()
    };
  }

  // Rest of the PeerHealthManager methods...
  // (keeping your original implementation)
  async checkPeerHealth(peer) {
    if (this.checkLocks.get(peer.publicKey)) {
      return this.isPeerHealthy(peer.publicKey);
    }
  
    this.checkLocks.set(peer.publicKey, true);
    const now = Date.now();
    this.metrics.totalChecks++;
  
    try {
      // Add logging to track connection attempts
      console.log(`[${new Date().toISOString()}] Attempting health check for peer: ${peer.publicKey}`);
      
      const connection = await getHyperteleConnection(peer.publicKey);
      console.log(`[${new Date().toISOString()}] Got connection on port ${connection.port} for peer: ${peer.publicKey}`);
      
      const response = await axios.get(`http://127.0.0.1:${connection.port}/health`, {
        timeout: 5000,
        validateStatus: (status) => status >= 200 && status < 500
      });
      
      console.log(`[${new Date().toISOString()}] Health check response for peer ${peer.publicKey}:`, 
        { status: response.status, data: response.data });
      
      if (response.status === 200 && this.validateHealthResponse(response.data)) {
        peer.lastSeen = now;
        this.healthChecks.set(peer.publicKey, {
          lastCheck: now,
          status: 'healthy',
          responseTime: Date.now() - now
        });
  
        if (this.failureCount.get(peer.publicKey)) {
          this.metrics.recoveredPeers++;
          this.failureCount.delete(peer.publicKey);
        }
  
        return true;
      }
      
      await this.recordFailure(peer.publicKey);
      return false;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Health check failed for peer ${peer.publicKey}:`, error.message);
      this.metrics.failedChecks++;
      this.healthChecks.set(peer.publicKey, {
        lastCheck: now,
        status: 'unhealthy',
        error: error.message,
        errorType: error.code || 'UNKNOWN'
      });
      await this.recordFailure(peer.publicKey);
      return false;
    } finally {
      this.checkLocks.delete(peer.publicKey);
    }
  }

  validateHealthResponse(data) {
    console.log(`[${new Date().toISOString()}] Validating health response:`, data);
    return data && (
      data.status === 'healthy' || 
      data.state === 'ok' || 
      data.status === 'ok' ||
      data.health === 'ok' ||
      data.alive === true
    );
  }

  isPeerHealthy(publicKey) {
    const check = this.healthChecks.get(publicKey);
    if (!check) return false;
    
    const now = Date.now();
    return (
      check.status === 'healthy' && 
      (now - check.lastCheck) < this.cleanupThreshold &&
      !this.isCircuitBroken(publicKey)
    );
  }

  isCircuitBroken(publicKey) {
    const breakerInfo = this.healthChecks.get(publicKey);
    if (!breakerInfo || !breakerInfo.circuitBroken) return false;
    
    if (Date.now() - breakerInfo.circuitBrokenAt > this.circuitBreakerTimeout) {
      delete breakerInfo.circuitBroken;
      delete breakerInfo.circuitBrokenAt;
      this.healthChecks.set(publicKey, breakerInfo);
      return false;
    }
    return true;
  }

  recordFailure(publicKey) {
    const count = (this.failureCount.get(publicKey) || 0) + 1;
    this.failureCount.set(publicKey, count);
    
    if (count >= this.circuitBreakerThreshold) {
      this.triggerCircuitBreaker(publicKey);
    }
  }

  triggerCircuitBreaker(publicKey) {
    const healthInfo = this.healthChecks.get(publicKey) || {};
    healthInfo.circuitBroken = true;
    healthInfo.circuitBrokenAt = Date.now();
    this.healthChecks.set(publicKey, healthInfo);
    
    console.log(`[${new Date().toISOString()}] Circuit breaker triggered for peer: ${publicKey}`);
  }

  getHealthMetrics() {
    const now = Date.now();
    const healthyPeers = Array.from(this.healthChecks.values())
      .filter(check => check.status === 'healthy').length;
    
    const metrics = {
      ...this.metrics,
      healthyPeers,
      unhealthyPeers: this.healthChecks.size - healthyPeers,
      circuitsBroken: Array.from(this.healthChecks.values())
        .filter(check => check.circuitBroken).length,
      timeSinceLastReset: now - this.metrics.lastMetricsReset
    };

    if (now - this.metrics.lastMetricsReset > 60 * 60 * 1000) {
      this.resetMetrics();
    }

    return metrics;
  }

  resetMetrics() {
    this.metrics = {
      totalChecks: 0,
      failedChecks: 0,
      recoveredPeers: 0,
      lastMetricsReset: Date.now()
    };
  }
}

// ============================
// Error Handling Classes
// ============================

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

class RetryableOperation {
  constructor(operation, maxRetries = 3, backoffMs = 1000) {
    this.operation = operation;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
  }

  async execute(...args) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.operation(...args);
      } catch (error) {
        lastError = error;
        console.error(`[${new Date().toISOString()}] Operation failed (attempt ${attempt}/${this.maxRetries}):`, error.message);
        if (attempt < this.maxRetries) {
          const delay = this.backoffMs * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }
}

// ============================
// Queue Management
// ============================

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async enqueue(message, processFunction) {
    this.queue.push({ message, processFunction, attempts: 0 });
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        
        if (item.attempts >= this.maxRetries) {
          console.log(`[${new Date().toISOString()}] Message dropped after ${this.maxRetries} failed attempts`);
          this.queue.shift();
          continue;
        }

        try {
          item.attempts++;
          await item.processFunction(item.message);
          this.queue.shift();
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error processing message (attempt ${item.attempts}/${this.maxRetries}):`, error);
          if (item.attempts >= this.maxRetries) {
            this.queue.shift();
          } else {
            this.queue.push(this.queue.shift());
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * item.attempts));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  clear() {
    this.queue = [];
    this.processing = false;
  }
}

class EnhancedMessageQueue extends MessageQueue {
  constructor(options = {}) {
    super();
    this.operationTimeout = options.operationTimeout || 30000; // 30 seconds default
    this.processTimeout = options.processTimeout || 120000; // 2 minutes default
    this.abortController = new AbortController();
  }

  async processWithTimeout(operation) {
    const timeout = setTimeout(() => {
      this.abortController.abort();
    }, this.operationTimeout);

    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new TimeoutError('Operation timed out')), 
          this.operationTimeout)
        )
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const queueTimeout = setTimeout(() => {
      this.abortController.abort();
      this.processing = false;
    }, this.processTimeout);

    try {
      while (this.queue.length > 0 && !this.abortController.signal.aborted) {
        const item = this.queue[0];
        
        if (item.attempts >= this.maxRetries) {
          console.log(`[${new Date().toISOString()}] Message dropped after ${this.maxRetries} failed attempts`);
          this.queue.shift();
          continue;
        }

        try {
          item.attempts++;
          await this.processWithTimeout(async () => {
            await item.processFunction(item.message);
          });
          this.queue.shift();
        } catch (error) {
          if (error instanceof TimeoutError) {
            console.error(`[${new Date().toISOString()}] Operation timed out:`, error.message);
          } else {
            console.error(`[${new Date().toISOString()}] Error processing message (attempt ${item.attempts}/${this.maxRetries}):`, error.message);
          }

          if (item.attempts >= this.maxRetries) {
            this.queue.shift();
          } else {
            this.queue.push(this.queue.shift());
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * item.attempts));
        }
      }
    } finally {
      clearTimeout(queueTimeout);
      this.processing = false;
      this.abortController = new AbortController();
    }
  }
}

// ============================
// State Management
// ============================

let activePeers = [];
const activeRelays = new Map();
const wsConnections = new Map();
const connectionPool = new Map();
const messageQueues = new Map();
const peerHealthManager = new PeerHealthManager();

// Create express app early
const app = express();

// Configure express middleware
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Root route handler
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hypertuna Gateway Active',
    peers: activePeers.length,
    relays: activeRelays.size,
    timestamp: new Date().toISOString()
  });
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Global variables for Hyperdrive
let store, swarm, local, drive, mirror;

// ============================
// Hyperdrive Setup
// ============================

async function initializeHyperdrive() {
  store = new Corestore('./storage');
  swarm = new Hyperswarm();
  swarm.on('connection', conn => store.replicate(conn));
  
  local = new Localdrive('./writer-dir');
  drive = new Hyperdrive(store);
  
  await drive.ready();
  const discovery = swarm.join(drive.discoveryKey);
  await discovery.flushed();
  console.log('drive key:', b4a.toString(drive.key, 'hex'));
  
  // Set up mirror function
  mirror = debounce(mirrorDrive);
  
  return { store, swarm, local, drive };
}

// ============================
// Server Initialization
// ============================

async function startServer() {
  try {
    console.log('Initializing Hypertuna Gateway with Local WSS Server...');
    
    // Create LocalWSSServer instance
    const wssServer = await new LocalWSSServer({
      hostname: 'hypertuna-gateway',
      port: 8443,
      certificateValidityDays: 365,
      detectPublicIp: true
    }).init();

    // Display IP information
    const ipInfo = wssServer.getIpAddresses();
    console.log('\nDetected IP Addresses:');
    console.log('Primary IP:', ipInfo.primary);
    console.log('Local IPs:', ipInfo.local.join(', '));
    console.log('Public IP:', ipInfo.public || 'Not detected or not accessible');

    // Display connection URLs
    const urls = wssServer.getServerUrls();
    console.log('\nServer URLs:');
    console.log('Hostname URL:', urls.hostname);
    console.log('Local URLs:', urls.local.join(', '));
    if (urls.public) {
      console.log('Public URL:', urls.public, '(requires port forwarding)');
      
      const isPortForwarded = await wssServer.checkPortForwarding();
      console.log('Port forwarding configured:', isPortForwarded ? 'Yes' : 'No or Not Verifiable');
    }

    // Generate certificates if needed
    if (!wssServer.checkCertificates()) {
      console.log('Certificates are missing or expired, generating new ones...');
      wssServer.generateCertificates();
    }

    // Read certificate files for the HTTPS server
    const credentials = {
      key: fs.readFileSync(wssServer.certPaths.privkey),
      cert: fs.readFileSync(wssServer.certPaths.cert),
      ca: fs.readFileSync(wssServer.certPaths.ca)
    };

    // Create HTTPS server with Express app
    const server = https.createServer(credentials, app);
    
    // Create WebSocket server on top of HTTPS server
    const wss = new WebSocket.Server({ server });
    
    // Set up WebSocket connections
    wss.on('connection', (ws, req) => {
      const pathname = url.parse(req.url).pathname;
      const relayKey = pathname.split('/')[1];
    
      console.log(`[${new Date().toISOString()}] New WebSocket connection for relay: ${relayKey}`);
    
      if (activeRelays.has(relayKey)) {
        handleWebSocket(ws, relayKey);
      } else {
        console.log(`[${new Date().toISOString()}] Invalid relay key: ${relayKey}. Closing connection.`);
        ws.close(1008, 'Invalid relay key');
      }
    });
    
    // Start the server
    server.listen(wssServer.config.port, '0.0.0.0', async () => {
      console.log(`[${new Date().toISOString()}] Gateway server running on port ${wssServer.config.port}`);
      
      // Initialize Hyperdrive after server starts
      await initializeHyperdrive();
      await updateNetworkStats();
      
      console.log('Server fully initialized and running');
    });

    // Set up maintenance interval
    setInterval(async () => {
      try {
        await cleanupInactivePeers();
        
        // Cleanup unused connections
        const now = Date.now();
        for (const [peerPublicKey, connection] of connectionPool.entries()) {
          if (connection.lastUsed < now - 10 * 60 * 1000) {
            await closeConnection(peerPublicKey);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Maintenance cycle error:`, error);
      }
    }, 60000);

    // Handle stdin for manual mirroring
    stdio.in.setEncoding('utf-8');
    stdio.in.on('data', (data) => {
      if (!data.match('\n')) return;
      mirror();
    });

    return { server, wss, wssServer };
  } catch (error) {
    console.error('Error starting server:', error.message);
    throw error;
  }
}

// ============================
// Connection Management
// ============================

async function getHyperteleConnection(peerPublicKey) {
  try {
    if (connectionPool.has(peerPublicKey)) {
      const connection = connectionPool.get(peerPublicKey);
      if (connection.lastUsed > Date.now() - 5 * 60 * 1000) {
        connection.lastUsed = Date.now();
        return connection;
      }
      await closeConnection(peerPublicKey);
    }

    const connection = await createNewConnection(peerPublicKey);
    connectionPool.set(peerPublicKey, connection);
    return connection;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Connection error for peer ${peerPublicKey}:`, error.message);
    await closeConnection(peerPublicKey);
    throw error;
  }
}

async function createNewConnection(peerPublicKey) {
  const hyperteleClient = spawn('hypertele', ['-p', '0', '-s', peerPublicKey]);
  
  const clientPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      hyperteleClient.kill();
      reject(new Error('Connection timeout'));
    }, 5000);

    hyperteleClient.stdout.on('data', (data) => {
      const match = data.toString().match(/Server ready @.*:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    hyperteleClient.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  await waitForPort(clientPort);

  return {
    client: hyperteleClient,
    port: clientPort,
    lastUsed: Date.now()
  };
}

async function closeConnection(peerPublicKey) {
  const connection = connectionPool.get(peerPublicKey);
  if (connection) {
    connection.client.kill();
    connectionPool.delete(peerPublicKey);
  }
}

// ============================
// Message Handling
// ============================

async function forwardMessageToPeer(peerPublicKey, relayKey, message, connectionKey) {
  let connection;
  let peer = activePeers.find(p => p.publicKey === peerPublicKey);
  
  try {
    if (!peer || !peerHealthManager.isPeerHealthy(peerPublicKey)) {
      const healthyPeer = await findHealthyPeerForRelay(relayKey);
      if (!healthyPeer) {
        throw new Error('No healthy peers available for this relay');
      }
      peer = healthyPeer;
    }

    connection = await getHyperteleConnection(peer.publicKey);
    const response = await axios.post(
      `http://127.0.0.1:${connection.port}/post/relay/${relayKey}`,
      { message, connectionKey },
      {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
        responseType: 'text'
      }
    );

    return response.data.split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line));
  } catch (error) {
    if (peer) {
      await peerHealthManager.recordFailure(peer.publicKey);
    }
    throw error;
  } finally {
    if (connection) {
      connection.lastUsed = Date.now();
    }
  }
}

// ============================
// WebSocket Message Queue Handling
// ============================

function handleWebSocket(ws, relayKey) {
  const connectionKey = generateConnectionKey();
  console.log(`[${new Date().toISOString()}] New WebSocket connection established:`, {
    relayKey,
    connectionKey
  });
  
  wsConnections.set(connectionKey, { ws, relayKey });
  const messageQueue = new EnhancedMessageQueue({
    operationTimeout: 30000,
    processTimeout: 120000
  });
  messageQueues.set(connectionKey, messageQueue);

  // Add connection status check
  if (ws.readyState !== WebSocket.OPEN) {
    console.error(`[${new Date().toISOString()}] WebSocket not in OPEN state for relay ${relayKey}:`, 
      { readyState: ws.readyState });
    return;
  }

  ws.on('message', async (message) => {
    const processMessage = async (msg) => {
      console.log(`[${new Date().toISOString()}] Processing WebSocket message for relay ${relayKey}`);
      
      const healthyPeer = await findHealthyPeerForRelay(relayKey);
      if (!healthyPeer) {
        console.error(`[${new Date().toISOString()}] No healthy peers found for relay ${relayKey}`);
        ws.send(JSON.stringify(['NOTICE', 'No healthy peers available for this relay']));
        return;
      }

      try {
        const responses = await forwardMessageToPeer(healthyPeer.publicKey, relayKey, msg, connectionKey);
        for (const response of responses) {
          if (response && response.length > 0) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(response));
            } else {
              console.error(`[${new Date().toISOString()}] WebSocket not in OPEN state when trying to send response`);
              cleanup(connectionKey);
              return;
            }
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error processing message:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
        }
      }
    };

    await messageQueue.enqueue(message, processMessage);
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] WebSocket connection closed for relay ${relayKey}`);
    cleanup(connectionKey);
  });

  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] WebSocket error for relay ${relayKey}:`, error);
    cleanup(connectionKey);
  });

  startEventChecking(connectionKey);
}

// ============================
// Network Stats Handling
// ============================

async function updateNetworkStats() {
  const retryableUpdate = new RetryableOperation(async () => {
    try {
      const healthMetrics = peerHealthManager.getHealthMetrics();

      const stats = {
        active_relays: activeRelays.size,
        peers_online: activePeers.length,
        health_metrics: healthMetrics,
        relays: {},
        last_update: new Date().toISOString()
      };

      // Enhanced relay statistics
      for (const [relayKey, relayData] of activeRelays.entries()) {
        const healthyPeers = Array.from(relayData.peers)
          .filter(peer => peerHealthManager.isPeerHealthy(peer));
        
        stats.relays[relayKey] = {
          status: healthyPeers.length > 0 ? 'online' : 'degraded',
          total_peers: relayData.peers.size,
          healthy_peers: healthyPeers.length,
          relayProfileInfo: relayData.relayProfileInfo,
          health_percentage: (healthyPeers.length / relayData.peers.size) * 100,
          last_successful_message: relayData.lastSuccessfulMessage || null
        };
      }

      const jsonPath = path.join('./writer-dir', 'network_stats.json');
      await fs.promises.writeFile(jsonPath, JSON.stringify(stats, null, 2));
      
      // Enhanced drive mirroring with timeout
      const mirrorTimeout = 30000; // 30 seconds
      try {
        await Promise.race([
          mirror(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Drive mirror timeout')), mirrorTimeout)
          )
        ]);
      } catch (mirrorError) {
        console.error(`[${new Date().toISOString()}] Drive mirror error:`, mirrorError.message);
        // Don't throw here, continue with the update
      }

      return stats;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Stats update error:`, error.message);
      throw error; // Retry will handle this
    }
  }, 3, 2000); // 3 retries, 2 second initial backoff

  try {
    return await retryableUpdate.execute();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal error updating network stats:`, error.message);
    return null;
  }
}

// ============================
// Event Checking and Monitoring
// ============================

async function startEventChecking(connectionKey) {
  const checkEvents = async () => {
    const connectionData = wsConnections.get(connectionKey);
    if (!connectionData) {
      return;
    }

    const { ws, relayKey } = connectionData;
    
    try {
      const healthyPeer = await findHealthyPeerForRelay(relayKey);
      if (!healthyPeer) {
        return;
      }

      const connection = await getHyperteleConnection(healthyPeer.publicKey);
      const response = await axios.get(
        `http://127.0.0.1:${connection.port}/get/relay/${relayKey}/${connectionKey}`,
        {
          timeout: 30000,
          responseType: 'json'
        }
      );

      const events = response.data;
      
      if (events && events.length > 0) {
        for (const event of events) {
          ws.send(JSON.stringify(event));
        }
        console.log(`[${new Date().toISOString()}] Sent ${events.length} events for connectionKey: ${connectionKey}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Event check error for ${connectionKey}:`, error.message);
    }

    if (wsConnections.has(connectionKey)) {
      setTimeout(() => checkEvents(), 10000);
    }
  };

  checkEvents();
}

// ============================
// HTTP Endpoints
// ============================

app.post('/register', async (req, res) => {
    const { publicKey, relays, relayProfileInfo } = req.body;
    console.log(`[${new Date().toISOString()}] Received registration request:`, {
      publicKey,
      relaysCount: relays?.length,
      hasRelayProfileInfo: !!relayProfileInfo
    });
  
    if (!publicKey) {
      console.log(`[${new Date().toISOString()}] Registration failed: No public key provided`);
      return res.status(400).json({
        error: 'Public key is required',
        timestamp: new Date().toISOString()
      });
    }
  
    let peer = activePeers.find(p => p.publicKey === publicKey);
    if (!peer) {
      peer = { 
        publicKey, 
        lastSeen: Date.now(), 
        relays: new Set(),
        status: 'active',
        registeredAt: Date.now()
      };
      activePeers.push(peer);
      console.log(`[${new Date().toISOString()}] New peer registered:`, peer);
    } else {
      peer.lastSeen = Date.now();
      peer.status = 'active';
      console.log(`[${new Date().toISOString()}] Existing peer updated:`, peer);
    }
  
    if (relays && Array.isArray(relays)) {
      relays.forEach(relayKey => {
        peer.relays.add(relayKey);
        
        if (!activeRelays.has(relayKey)) {
          activeRelays.set(relayKey, { 
            peers: new Set(),
            relayProfileInfo: null,
            status: 'active',
            createdAt: Date.now(),
            lastActive: Date.now()
          });
        }
        
        const relayData = activeRelays.get(relayKey);
        relayData.peers.add(publicKey);
        relayData.lastActive = Date.now();
        
        if (relayProfileInfo && relays.length === 1) {
          relayData.relayProfileInfo = relayProfileInfo;
          console.log(`[${new Date().toISOString()}] Updated relay-profile info for relay: ${relayKey}`);
        }
      });
    }
  
    // Immediately check health of the newly registered peer
    try {
      const isHealthy = await peerHealthManager.checkPeerHealth(peer);
      console.log(`[${new Date().toISOString()}] Initial health check for peer ${publicKey}:`, {
        isHealthy,
        healthStatus: peerHealthManager.healthChecks.get(publicKey)
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error during initial health check:`, error);
    }
  
    console.log(`[${new Date().toISOString()}] Registration complete. Active peers: ${activePeers.length}`);
    console.log(`[${new Date().toISOString()}] Active relays:`, 
      Array.from(activeRelays.entries()).map(([key, value]) => ({
        key,
        peers: value.peers.size,
        hasRelayProfileInfo: !!value.relayProfileInfo,
        lastActive: new Date(value.lastActive).toISOString()
      }))
    );
  
    await updateNetworkStats();
  
    const driveKey = b4a.toString(drive.key, 'hex');
    res.json({ 
      message: 'Registered successfully', 
      driveKey,
      status: 'active',
      timestamp: new Date().toISOString()
    });
  });
  
  // ============================
  // Helper Functions
  // ============================
  
  function generateConnectionKey() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  async function findHealthyPeerForRelay(relayKey) {
    console.log(`[${new Date().toISOString()}] Finding healthy peer for relay ${relayKey}`);
    
    const relayData = activeRelays.get(relayKey);
    if (!relayData || relayData.peers.size === 0) {
      console.log(`[${new Date().toISOString()}] No relay data or peers found for relay ${relayKey}`);
      return null;
    }
  
    const peers = Array.from(relayData.peers)
      .map(peerKey => activePeers.find(p => p.publicKey === peerKey))
      .filter(Boolean);
    
    console.log(`[${new Date().toISOString()}] Found ${peers.length} potential peers for relay ${relayKey}`);
  
    for (const peer of peers) {
      console.log(`[${new Date().toISOString()}] Checking health of peer ${peer.publicKey}`);
      if (await peerHealthManager.checkPeerHealth(peer)) {
        console.log(`[${new Date().toISOString()}] Found healthy peer ${peer.publicKey} for relay ${relayKey}`);
        return peer;
      }
    }
  
    console.log(`[${new Date().toISOString()}] No healthy peers found for relay ${relayKey}`);
    return null;
  }
  
  function removePeerFromAllRelays(peer) {
    for (const [relayKey, relayData] of activeRelays.entries()) {
      relayData.peers.delete(peer.publicKey);
      if (relayData.peers.size === 0) {
        activeRelays.delete(relayKey);
      }
    }
  }
  
  async function cleanupInactivePeers() {
    const initialCount = activePeers.length;
    
    for (const peer of [...activePeers]) {
      if (!peerHealthManager.isPeerHealthy(peer.publicKey)) {
        const isHealthy = await peerHealthManager.checkPeerHealth(peer);
        if (!isHealthy) {
          removePeerFromAllRelays(peer);
          await closeConnection(peer.publicKey);
          activePeers = activePeers.filter(p => p.publicKey !== peer.publicKey);
        }
      }
    }
  
    if (activePeers.length < initialCount) {
      console.log(`[${new Date().toISOString()}] Removed ${initialCount - activePeers.length} inactive peers. Current count: ${activePeers.length}`);
      await updateNetworkStats();
    }
  }
  
  function cleanup(connectionKey) {
    const connection = wsConnections.get(connectionKey);
    if (connection) {
      connection.ws.close();
      wsConnections.delete(connectionKey);
    }
    
    const queue = messageQueues.get(connectionKey);
    if (queue) {
      queue.clear();
      messageQueues.delete(connectionKey);
    }
  }
  
  async function waitForPort(port, timeout = 2000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        await new Promise((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(500);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', (error) => {
            socket.destroy();
            reject(error);
          });
          socket.once('timeout', () => {
            socket.destroy();
            reject(new Error('Connection timeout'));
          });
          socket.connect(port, '127.0.0.1');
        });
        return;
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw new Error(`Timeout waiting for port ${port}`);
  }
  
  // ============================
  // Drive Mirroring
  // ============================
  
  async function mirrorDrive() {
    console.log(`[${new Date().toISOString()}] Starting drive mirror...`);
    
    try {
      const mirrorInstance = local.mirror(drive);
      await Promise.race([
        mirrorInstance.done(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Drive mirror timeout')), 30000)
        )
      ]);
      
      console.log(`[${new Date().toISOString()}] Mirror complete:`, mirrorInstance.count);
      return mirrorInstance.count;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Mirror error:`, error.message);
      throw error;
    }
  }
  
  // ============================
  // HTTP Request Handling
  // ============================
  
  app.use(async (req, res, next) => {
    // Skip this middleware for health checks and registration
    if (req.path === '/health' || req.path === '/register') {
      return next();
    }
  
    if (req.path === '/') {
      console.log(`[${new Date().toISOString()}] ROOT PATH REQUEST RECEIVED`);
    }
  
    console.log(`[${new Date().toISOString()}] Received request for: ${req.url}`);
  
    // Log active peers
    console.log(`[${new Date().toISOString()}] Active peers: ${activePeers.length}`);
    activePeers.forEach(peer => {
      if (peer && peer.publicKey) {
        console.log(`  - ${peer.publicKey} (last seen: ${new Date(peer.lastSeen)})`);
      }
    });
  
    if (activePeers.length === 0) {
      console.log(`[${new Date().toISOString()}] No peers available`);
      return res.status(503).json({
        status: 'error',
        message: 'No peers available',
        timestamp: new Date().toISOString()
      });
    }
  
    // Select a random peer with validation
    const validPeers = activePeers.filter(p => p && p.publicKey && p.lastSeen);
    if (validPeers.length === 0) {
      console.log(`[${new Date().toISOString()}] No valid peers available`);
      return res.status(503).json({
        status: 'error',
        message: 'No valid peers available',
        timestamp: new Date().toISOString()
      });
    }
  
    const peer = validPeers[Math.floor(Math.random() * validPeers.length)];
    console.log(`[${new Date().toISOString()}] Selected peer: ${peer.publicKey}`);
  
    try {
      const result = await handleRequestWithPeer(peer, req, res);
      if (!result) {
        res.status(502).json({
          status: 'error',
          message: 'Unable to process request',
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error with peer ${peer.publicKey}: ${error.message}`);
      res.status(500).json({
        status: 'error',
        message: 'Internal Server Error',
        timestamp: new Date().toISOString()
      });
    }
  });
  
  async function handleRequestWithPeer(peer, req, res) {
    try {
      const connection = await getHyperteleConnection(peer.publicKey);
  
      // Use the same method as the original request
      console.log(`[${new Date().toISOString()}] Forwarding ${req.method} request to http://127.0.0.1:${connection.port}${req.url}`);
      
      const proxyRes = await axios({
        method: req.method,
        url: `http://127.0.0.1:${connection.port}${req.url}`,
        data: req.method !== 'GET' ? req.body : undefined,
        responseType: 'arraybuffer',
        headers: req.headers,
        timeout: 5000,
        validateStatus: function (status) {
          return status >= 200 && status < 500;
        },
      });
      
      console.log(`[${new Date().toISOString()}] Received response from peer with status: ${proxyRes.status}`);
  
      // Set the response headers
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
  
      // Send the response body
      res.status(proxyRes.status).send(proxyRes.data);
      console.log(`[${new Date().toISOString()}] Response sent to client`);
  
      // Update the last seen timestamp for the peer
      peer.lastSeen = Date.now();
  
      return true; // Request handled successfully
    } catch (error) {
      if (error.response && error.response.status < 500) {
        // For 4xx errors, we still consider the peer responsive
        console.log(`[${new Date().toISOString()}] Peer responded with status ${error.response.status}`);
        res.status(error.response.status).send(error.response.data);
        peer.lastSeen = Date.now();
        return true;
      }
      throw error; // Propagate other errors to be handled in the main request handler
    }
  }
  
  // ============================
  // Graceful Shutdown
  // ============================
  
  process.on('SIGINT', async () => {
    console.log('Initiating graceful shutdown...');
    
    for (const [connectionKey, queue] of messageQueues.entries()) {
      if (queue) queue.clear();
    }
    messageQueues.clear();
    
    for (const { ws } of wsConnections.values()) {
      ws.close();
    }
    wsConnections.clear();
    
    for (const connection of connectionPool.values()) {
      connection.client.kill();
    }
    connectionPool.clear();
    
    try {
      if (swarm) await swarm.destroy();
      if (drive) await drive.close();
      
      console.log('Server shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  });
  
  // ============================
  // Main Startup
  // ============================
  
  // Export for testing
  module.exports = {
    startServer,
    peerHealthManager,
    activeRelays,
    activePeers,
    wsConnections,
    connectionPool,
    messageQueues
  };
  
  // If this script is run directly, start the server
  if (require.main === module) {
    startServer().catch(error => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
  }
