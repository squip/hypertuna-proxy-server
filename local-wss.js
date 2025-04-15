// local-wss.js - Local WSS Server Module with Self-Signed Certificates
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { createHash } = require('crypto');
const forge = require('node-forge');
const os = require('os');
const http = require('http');
const dns = require('dns').promises;

class LocalWSSServer {
  constructor(config = {}) {
    // Default configuration
    this.config = {
      hostname: config.hostname || 'localhost',
      ip: config.ip || null, // Will be auto-detected if null
      certsDir: config.certsDir || path.join(process.cwd(), 'certs'),
      port: config.port || 8443,
      certificateValidityDays: config.certificateValidityDays || 365, // 1 year
      detectPublicIp: config.detectPublicIp !== undefined ? config.detectPublicIp : true,
      publicIpServices: config.publicIpServices || [
        'https://api.ipify.org',
        'https://ifconfig.me/ip',
        'https://icanhazip.com'
      ],
      ...config
    };

    // Paths to certificate files
    this.certPaths = {
      privkey: path.join(this.config.certsDir, 'privkey.pem'),
      cert: path.join(this.config.certsDir, 'cert.pem'),
      ca: path.join(this.config.certsDir, 'ca.pem'),
    };

    this.server = null;
    this.wss = null;
    this.localIps = [];
    this.publicIp = null;
  }

  /**
   * Initialize the module by checking and creating necessary directories
   */
  async init() {
    console.log('Initializing Local WSS Server...');

    // Create certificates directory if it doesn't exist
    if (!fs.existsSync(this.config.certsDir)) {
      console.log(`Creating certificates directory: ${this.config.certsDir}`);
      fs.mkdirSync(this.config.certsDir, { recursive: true });
    }

    // Detect IP addresses
    await this._detectIpAddresses();

    return this;
  }

  /**
   * Detect local and public IP addresses
   * @private
   */
  async _detectIpAddresses() {
    // Get local IP addresses
    this.localIps = this._getLocalIps();
    
    // Use provided IP if specified
    if (this.config.ip) {
      if (!this.localIps.includes(this.config.ip)) {
        this.localIps.push(this.config.ip);
      }
    } else if (this.localIps.length > 0) {
      // Use the first non-localhost IP as the default
      this.config.ip = this.localIps.find(ip => !ip.startsWith('127.') && ip !== 'localhost') || '127.0.0.1';
    }

    console.log(`Detected local IP addresses: ${this.localIps.join(', ')}`);
    console.log(`Using primary IP: ${this.config.ip}`);

    // Get public IP if enabled
    if (this.config.detectPublicIp) {
      try {
        this.publicIp = await this._getPublicIp();
        if (this.publicIp) {
          console.log(`Detected public IP address: ${this.publicIp}`);
          // Add public IP to the list if not already there
          if (!this.localIps.includes(this.publicIp)) {
            this.localIps.push(this.publicIp);
          }
        }
      } catch (error) {
        console.warn(`Warning: Failed to detect public IP address: ${error.message}`);
      }
    }

    // Attempt to resolve hostname to check if it's configured
    try {
      const resolvedIps = await dns.lookup(this.config.hostname, { all: true });
      const resolvedAddresses = resolvedIps.map(entry => entry.address);
      console.log(`Hostname ${this.config.hostname} resolves to: ${resolvedAddresses.join(', ') || 'Not resolvable'}`);
    } catch (error) {
      console.warn(`Warning: Hostname ${this.config.hostname} is not resolvable. You may need to add it to your hosts file.`);
    }
  }

  /**
   * Get all local IP addresses from network interfaces
   * @private
   * @returns {string[]} Array of IP addresses
   */
  _getLocalIps() {
    const interfaces = os.networkInterfaces();
    const ipAddresses = ['127.0.0.1'];
    
    // Get all IPv4 addresses from all network interfaces
    Object.values(interfaces).forEach(iface => {
      iface.forEach(addr => {
        if (addr.family === 'IPv4' && !addr.internal) {
          ipAddresses.push(addr.address);
        }
      });
    });
    
    return [...new Set(ipAddresses)]; // Remove duplicates
  }

  /**
   * Get public IP address from external services
   * @private
   * @returns {Promise<string>} Public IP address
   */
  async _getPublicIp() {
    // Try each service until one works
    for (const service of this.config.publicIpServices) {
      try {
        const ip = await this._fetchPublicIp(service);
        if (ip) return ip;
      } catch (error) {
        console.warn(`Warning: Failed to get public IP from ${service}: ${error.message}`);
      }
    }
    return null;
  }

  /**
   * Fetch public IP from a specific service
   * @private
   * @param {string} url Service URL
   * @returns {Promise<string>} Public IP address
   */
  _fetchPublicIp(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        timeout: 5000, // 5 second timeout
        headers: {
          'User-Agent': 'LocalWSSServer/1.0'
        }
      }, (response) => {
        if (response.statusCode !== 200) {
          return reject(new Error(`Status code: ${response.statusCode}`));
        }
        
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          const ip = data.trim();
          // Validate IP format with simple regex
          if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
            resolve(ip);
          } else {
            reject(new Error('Invalid IP format returned'));
          }
        });
      });
      
      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timed out'));
      });
    });
  }

  /**
   * Generate self-signed certificates
   * @returns {boolean} Success status
   */
  generateCertificates() {
    console.log(`Generating self-signed certificates for ${this.config.hostname} and detected IPs...`);

    try {
      // Generate a CA certificate
      const caKeys = forge.pki.rsa.generateKeyPair(2048);
      const caCert = forge.pki.createCertificate();
      
      caCert.publicKey = caKeys.publicKey;
      caCert.serialNumber = this._generateSerialNumber();
      caCert.validity.notBefore = new Date();
      caCert.validity.notAfter = new Date();
      caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10); // 10 years
      
      const caAttrs = [
        { name: 'commonName', value: `${this.config.hostname} Local CA` },
        { name: 'countryName', value: 'US' },
        { name: 'organizationName', value: 'Local Development' },
      ];
      
      caCert.setSubject(caAttrs);
      caCert.setIssuer(caAttrs);
      
      caCert.setExtensions([
        {
          name: 'basicConstraints',
          cA: true
        },
        {
          name: 'keyUsage',
          keyCertSign: true,
          cRLSign: true
        }
      ]);
      
      // Self-sign the CA certificate
      caCert.sign(caKeys.privateKey, forge.md.sha256.create());
      
      // Convert to PEM format
      const caPem = forge.pki.certificateToPem(caCert);
      const caPrivateKeyPem = forge.pki.privateKeyToPem(caKeys.privateKey);
      
      // Save CA certificate
      fs.writeFileSync(this.certPaths.ca, caPem);
      
      // Generate a server certificate
      const serverKeys = forge.pki.rsa.generateKeyPair(2048);
      const serverCert = forge.pki.createCertificate();
      
      serverCert.publicKey = serverKeys.publicKey;
      serverCert.serialNumber = this._generateSerialNumber();
      serverCert.validity.notBefore = new Date();
      serverCert.validity.notAfter = new Date();
      serverCert.validity.notAfter.setDate(serverCert.validity.notBefore.getDate() + this.config.certificateValidityDays);
      
      const serverAttrs = [
        { name: 'commonName', value: this.config.hostname },
        { name: 'countryName', value: 'US' },
        { name: 'organizationName', value: 'Local Development' }
      ];
      
      serverCert.setSubject(serverAttrs);
      serverCert.setIssuer(caAttrs); // Issuer is the CA
      
      // Build list of alternative names for the certificate
      const altNames = [
        { type: 2, value: this.config.hostname },
        { type: 2, value: 'localhost' }
      ];
      
      // Add all detected IPs as SANs (only numeric IP addresses)
      this.localIps.forEach(ip => {
        // Only add if it matches an IP address pattern
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          altNames.push({ type: 7, ip });
        }
      });
      
      // Add public IP if detected
      if (this.publicIp && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(this.publicIp)) {
        // Only add if it's not already in the list
        if (!this.localIps.includes(this.publicIp)) {
          altNames.push({ type: 7, ip: this.publicIp });
        }
      }
      
      // Set extensions
      serverCert.setExtensions([
        {
          name: 'basicConstraints',
          cA: false
        },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true
        },
        {
          name: 'extKeyUsage',
          serverAuth: true
        },
        {
          name: 'subjectAltName',
          altNames: altNames
        }
      ]);
      
      // Sign the server certificate with the CA key
      serverCert.sign(caKeys.privateKey, forge.md.sha256.create());
      
      // Convert to PEM format
      const serverCertPem = forge.pki.certificateToPem(serverCert);
      const serverPrivateKeyPem = forge.pki.privateKeyToPem(serverKeys.privateKey);
      
      // Save server certificate and private key
      fs.writeFileSync(this.certPaths.cert, serverCertPem);
      fs.writeFileSync(this.certPaths.privkey, serverPrivateKeyPem);
      
      // Set appropriate permissions
      fs.chmodSync(this.certPaths.privkey, 0o600);
      fs.chmodSync(this.certPaths.cert, 0o644);
      fs.chmodSync(this.certPaths.ca, 0o644);
      
      console.log('Certificate generation completed successfully');
      console.log('');
      console.log('IMPORTANT: To trust this certificate on your devices:');
      console.log(`1. Import the CA certificate (${this.certPaths.ca}) into your system/browser trust store`);
      console.log('2. For browsers like Chrome, you may need to restart the browser after importing');
      console.log('');
      console.log('Your server will be accessible via:');
      console.log(`- https://${this.config.hostname}:${this.config.port} (if hostname is in hosts file or DNS)`);
      
      this.localIps.forEach(ip => {
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          console.log(`- https://${ip}:${this.config.port}`);
        }
      });
      
      if (this.publicIp) {
        console.log(`- From external networks: https://${this.publicIp}:${this.config.port} (if port is forwarded)`);
      }
      
      return true;
    } catch (error) {
      console.error('Error generating certificates:', error.message);
      return false;
    }
  }

  /**
   * Generate a random serial number for the certificate
   * @private
   */
  _generateSerialNumber() {
    const hash = createHash('sha1');
    hash.update(Math.random().toString());
    return hash.digest('hex');
  }

  /**
   * Check if certificates exist and are valid
   * @returns {boolean} Are certificates valid
   */
  checkCertificates() {
    // Check if all certificate files exist
    const allFilesExist = Object.values(this.certPaths).every(path => fs.existsSync(path));
    
    if (!allFilesExist) {
      console.log('One or more certificate files do not exist');
      return false;
    }

    try {
      // Check certificate expiration
      const certData = fs.readFileSync(this.certPaths.cert);
      const cert = forge.pki.certificateFromPem(certData.toString());
      
      const now = new Date();
      const expiryDate = cert.validity.notAfter;
      const daysUntilExpiry = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
      
      console.log(`Certificate expires in ${daysUntilExpiry} days`);
      
      // Return true if certificate is valid (not expired)
      return daysUntilExpiry > 0;
    } catch (error) {
      console.error('Error checking certificate validity:', error.message);
      return false;
    }
  }

  /**
   * Start HTTPS and WebSocket Secure server
   * @param {Function} connectionHandler Callback function for new WebSocket connections
   * @returns {Object} The server and wss instances
   */
  startServer(connectionHandler) {
    if (!this.checkCertificates()) {
      console.log('Certificates are missing or expired, generating new ones...');
      this.generateCertificates();
    }
  
    // Read certificate files
    const credentials = {
      key: fs.readFileSync(this.certPaths.privkey),
      cert: fs.readFileSync(this.certPaths.cert),
      ca: fs.readFileSync(this.certPaths.ca)
    };
  
    // Create HTTPS server with request handler
    this.server = https.createServer(credentials, (req, res) => {
      // Simple HTML response for browser requests
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WebSocket Server</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 0 20px; line-height: 1.6; }
            h1 { color: #333; }
            pre { background-color: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto; }
            .success { color: #2a6e2a; }
            .error { color: #d8000c; }
            button { padding: 8px 16px; margin: 5px 0; cursor: pointer; }
            #status { margin-top: 20px; }
          </style>
        </head>
        <body>
          <h1>WebSocket Secure Server</h1>
          <p>The WebSocket server is running. You can connect to it using:</p>
          <ul>
            <li><strong>Hostname:</strong> ${this.config.hostname}:${this.config.port}</li>
            <li><strong>Local IP:</strong> ${this.config.ip}:${this.config.port}</li>
            ${this.publicIp ? `<li><strong>Public IP:</strong> ${this.publicIp}:${this.config.port} (requires port forwarding)</li>` : ''}
          </ul>
          
          <h2>Quick Test</h2>
          <p>Click the button below to test the WebSocket connection:</p>
          <button id="testBtn">Test Connection</button>
          <div id="status"></div>
          
          <h2>WebSocket Client Example</h2>
          <pre>
  const socket = new WebSocket('wss://${this.config.ip}:${this.config.port}');
  
  socket.onopen = () => {
    console.log('Connected to the server');
    socket.send('Hello from client');
  };
  
  socket.onmessage = (event) => {
    console.log('Received from server:', event.data);
  };
  
  socket.onclose = () => {
    console.log('Disconnected from the server');
  };
          </pre>
          
          <script>
            document.getElementById('testBtn').addEventListener('click', () => {
              const statusEl = document.getElementById('status');
              statusEl.innerHTML = 'Connecting...';
              
              try {
                const socket = new WebSocket('wss://' + window.location.host);
                
                socket.onopen = () => {
                  statusEl.innerHTML = '<span class="success">Connected successfully!</span>';
                  socket.send('Hello from test client');
                };
                
                socket.onmessage = (event) => {
                  statusEl.innerHTML += '<br>Received: ' + event.data;
                };
                
                socket.onclose = () => {
                  statusEl.innerHTML += '<br>Connection closed';
                };
                
                socket.onerror = (error) => {
                  statusEl.innerHTML = '<span class="error">Connection failed: ' + (error.message || 'Unknown error') + '</span>';
                };
              } catch (error) {
                statusEl.innerHTML = '<span class="error">Error: ' + error.message + '</span>';
              }
            });
          </script>
        </body>
        </html>
      `);
    });
    
    // Listen on all interfaces
      this.server.listen(this.config.port, '0.0.0.0', () => {
      console.log(`WSS Server running at https://${this.config.hostname}:${this.config.port}`);
      console.log(`Also accessible via IP addresses:`);
      this.localIps.forEach(ip => {
        console.log(`- https://${ip}:${this.config.port}`);
      });
      if (this.publicIp) {
        console.log(`- From external networks: https://${this.publicIp}:${this.config.port} (if port is forwarded)`);
      }
    });

    // Create WebSocket Server
    this.wss = new WebSocket.Server({ server: this.server });
    
    // Set up connection handler
    if (typeof connectionHandler === 'function') {
      this.wss.on('connection', connectionHandler);
    } else {
      // Default connection handler
      this.wss.on('connection', (ws, req) => {
        const clientIp = req.socket.remoteAddress;
        console.log(`Client connected from ${clientIp}`);
        
        ws.on('message', (message) => {
          console.log(`Received from ${clientIp}: ${message}`);
          // Echo the message back
          ws.send(message);
        });
        
        ws.on('close', () => {
          console.log(`Client disconnected from ${clientIp}`);
        });
      });
    }

    return { server: this.server, wss: this.wss };
  }

  /**
   * Stop the server
   */
  stopServer() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    
    console.log('Server stopped');
  }
  
  /**
   * Get the list of detected IP addresses
   * @returns {Object} Object containing local and public IPs
   */
  getIpAddresses() {
    return {
      local: this.localIps,
      public: this.publicIp,
      primary: this.config.ip
    };
  }
  
  /**
   * Get the server URL(s)
   * @returns {Object} Object containing server URLs
   */
  getServerUrls() {
    const urls = {
      hostname: `wss://${this.config.hostname}:${this.config.port}`,
      local: this.localIps
        .filter(ip => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
        .map(ip => `wss://${ip}:${this.config.port}`)
    };
    
    if (this.publicIp) {
      urls.public = `wss://${this.publicIp}:${this.config.port}`;
    }
    
    return urls;
  }

  /**
   * Check if port forwarding is configured properly for public access
   * @returns {Promise<boolean>} Is port forwarding configured
   */
  async checkPortForwarding() {
    if (!this.publicIp) {
      console.warn('Cannot check port forwarding without a public IP');
      return false;
    }
    
    try {
      const url = `https://${this.publicIp}:${this.config.port}`;
      console.log(`Checking port forwarding by connecting to ${url}`);
      
      // Attempt to connect to our own server through the public IP
      // This may not work from inside some networks due to NAT loopback limitations
      return new Promise((resolve) => {
        const req = https.get(url, {
          timeout: 5000,
          rejectUnauthorized: false
        }, (res) => {
          resolve(res.statusCode === 200);
          res.destroy();
        });
        
        req.on('error', () => {
          resolve(false);
        });
        
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
    } catch (error) {
      console.warn(`Port forwarding check failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = LocalWSSServer;
