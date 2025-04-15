# hypertuna-proxy-server
a simple proxy server module to coordinate NOSTR websocket request traffic across a swarm of Hypertuna Relay peers

**Note:**
- This module is an ongoing work-in-progress to be used as part of a larger integrated application, but I'd like to make the current proof-of-concept state available to any NOSTR / Pear builders who may be interested. Feel free to fork, provide feedback / improvements, or use in your project if useful. 

**Set-Up:**
1. `git clone https://github.com/squip/hypertuna-proxy-server`
2. `npm install`
3. run `node hypertuna-proxy-server.js` - this will initialize the proxy server and generate a /certs directory with self-signed .pem files to run the https / wss server.
4. if you are running the Hypertuna Proxy Server instance on your local machine and don't have port-forwarding set-up, import the .pem files in /certs to your OS's keychain access manager
5. navigate to your ip / open port (i.e. https://127.0.0.1:8443) in your browser, click 'proceed' if you encounter a security warning.
6. once proxy server is initialized / running, initialize the Hypertuna Relay Server in a separate terminal
   - follow install / set-up instructions here: https://github.com/squip/hypertuna-relay-server


