/*
 Copyright 2013 Daniel Wirtz <dcode@dcode.io>

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

/**
 * SourceCon (c) 2014 Daniel Wirtz <dcode@dcode.io>
 * Released under the Apache License, Version 2.0
 * see: https://github.com/dcodeIO/SourceCon for details
 */

var net = require("net"),
    events = require("events");

// Event      | Arguments        |
// -----------|------------------|
// connect    |                  |
// disconnect |                  |
// error      | Error            |
// message    | Object           |

/**
 * Constructs a new SourceCon.
 * @param {string} host Server hostname
 * @param {number} port Server RCON port
 * @extends events.EventEmitter
 */
var SourceCon = function(host, port) {
    events.EventEmitter.call(this);

    /**
     * Server hostname.
     * @type {string}
     */
    this.host = host;

    /**
     * Server RCON port.
     * @type {number}
     */
    this.port = port;

    /**
     * Next packet id.
     * @type {number}
     */
    this.packetId = 1;

    /**
     * Callback store.
     * @type {Object.<number,Object>}
     */
    this.callbackStore = {};

    /**
     * RCON connection.
     * @type {net.Socket}
     */
    this.socket = null;

    /**
     * Receive buffer.
     * @type {!Buffer}
     */
    this.buffer = new Buffer(0);

    /**
     * Enables debug output to console.
     * @type {boolean}
     */
    this.debug = false;
};

// Extends EventEmitter
SourceCon.prototype = Object.create(events.EventEmitter.prototype);

// Packet types
SourceCon.SERVERDATA_AUTH             = 3; // Client->Server
SourceCon.SERVERDATA_AUTH_RESPONSE  = 2; // Server->Client
SourceCon.SERVERDATA_EXECCOMMAND    = 2; // Client->Server
SourceCon.SERVERDATA_RESPONSE_VALUE = 0; // Server->Client
// Note: Rust uses type 4 for log messages

/**
 * Connects to the server.
 * @param {function(Error)=} cb Callback
 * @returns {boolean} `true` if now connecting, `false` if already connecting or connected
 */
SourceCon.prototype.connect = function(cb) {
    if (this.socket) return false;
    this.socket = new net.Socket();
    this.socket.on("error", function(err) {
        if (cb) cb(err);
        this.emit("error", err);
        this.disconnect();
    }.bind(this));
    this.socket.on("end", function() {
        this.disconnect();
    }.bind(this));
    this.socket.connect(this.port, this.host, function() {
        this.socket.on("data", function(data) {
            // Collect all incoming chunks
            this.buffer = Buffer.concat([this.buffer, data]);
            // And process what we have as soon as enough data is available
            this._process();
        }.bind(this));
        if (cb) cb(null);
        this.emit("connect");
    }.bind(this));
    return true;
};

/**
 * Disconnects from the server.
 * @returns {boolean} `true` if disconnected, `false` if already disconnected
 */
SourceCon.prototype.disconnect = function() {
    if (!this.socket) return false;
    this.socket.removeAllListeners();
    this.socket.end();
    this.socket = null;
    this.emit("disconnect");
    return true;
};

/**
 * Processes all buffered messages.
 * @private
 */
SourceCon.prototype._process = function() {
    while (this.buffer.length >= 12) {
        var size = this.buffer.readInt32LE(0),
            id   = this.buffer.readInt32LE(4),
            type = this.buffer.readInt32LE(8);
        if (this.buffer.length < 4+size) break; // Need more data
        var body = this.buffer.slice(12, 4+size-2);
        if (this.debug)
            console.log(">>> size="+size+", id="+id+", type="+type+" : "+body.toString("ascii"));
        if (this.callbackStore.hasOwnProperty(id)) {
            var cbs = this.callbackStore[id]; // {cb, id, type, buffer} OR {finId}
            if (typeof cbs.finId === 'number') {
                delete this.callbackStore[id];
                var finId = cbs.finId;
                if (this.callbackStore.hasOwnProperty(finId)) {
                    cbs = this.callbackStore[finId];
                    delete this.callbackStore[finId];
                    if (cbs.cb) cbs.cb(null, cbs.buffer);
                }
            } else {
                if (cbs.type === SourceCon.SERVERDATA_AUTH) {
                    // In this case all we need to know is the AUTH_RESPONSE
                    if (type === SourceCon.SERVERDATA_AUTH_RESPONSE) {
                        delete this.callbackStore[id];
                        if (cbs.cb) cbs.cb(null, {});
                    }
                } else if (cbs.type === SourceCon.SERVERDATA_RESPONSE_VALUE || cbs.type === SourceCon.SERVERDATA_EXECCOMMAND) {
                    // Collect everything, even multiple packets
                    if (cbs.buffer.length === 0) {
                        cbs.buffer = body;
                    } else {
                        cbs.buffer = Buffer.concat([cbs.buffer, body]);
                    }
                }
            }
        }
        this.emit("message", {
            size: size,
            id: id,
            type: type,
            body: body
        });
        this.buffer = this.buffer.slice(4+size, this.buffer.length);
    }
};

/**
 * Generates the next id value.
 * @param {number} id Current id value
 * @returns {number} Next id value
 */
function nextId(id) {
    id = ((id + 1) & 0xFFFFFFFF) | 0;
    if (id === -1) id++; // Do not use -1
    if (id === 0) id++; // Do not use 0
    return id;
}

/**
 * Creates a request packet.
 * @param {number} id Request id
 * @param {number} type Request type
 * @param {!Buffer} body Request data
 * @returns {!Buffer}
 */
function pack(id, type, body) {
    var buf = new Buffer(body.length + 14);
    buf.writeInt32LE(body.length + 10, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    body.copy(buf, 12);
    buf[buf.length-2] = 0;
    buf[buf.length-1] = 0;
    return buf;
}

/**
 * Sends a command to the server.
 * @param {!Buffer|string} cmd Command to execute
 * @param {number|function(Error, Buffer=)} type Message type (omittable)
 * @param {function(Error, Buffer=)=} cb Callback
 */
SourceCon.prototype.send = function(cmd, type, cb) {
    if (typeof type !== 'number') {
        cb = type;
        type = SourceCon.SERVERDATA_EXECCOMMAND;
    }
    if (!this.socket) {
        process.nextTick(function() {
            var err = new Error("Not connected");
            cb(err);
            this.emit("error", err);
        });
        return;
    }
    if (!Buffer.isBuffer(cmd)) {
        cmd = new Buffer(cmd, "ascii");
    }
    var req = pack(this.packetId, type, cmd),
        next_id = nextId(this.packetId);
    if (cb) {
        this.callbackStore[this.packetId] = { // Actual request
            cb: cb,
            id: this.packetId,
            type: type,
            buffer: new Buffer(0)
        };
    }
    this.callbackStore[next_id] = { // Pseudo SRV
        finId: this.packetId
    };
    if (this.debug)
        console.log("<<< size="+(req.length-4)+", id="+this.packetId+", type="+type+" : "+cmd.toString("ascii"));
    // Write the actual request
    this.socket.write(req);
    this.packetId = nextId(this.packetId);
    
    // Write an empty SRV to reliably find the end of the previous response
    if (type !== SourceCon.SERVERDATA_AUTH) {
        this.socket.write(pack(this.packetId, SourceCon.SERVERDATA_RESPONSE_VALUE, new Buffer(0)));
        this.packetId = nextId(this.packetId);
    }
};

/**
 * Authenticates with the server.
 * @param {string} pass RCON password
 * @param {function(Error)=} cb Callback
 */
SourceCon.prototype.auth = function(pass, cb) {
    this.send(pass, SourceCon.SERVERDATA_AUTH, function(err, data) {
        this.emit("auth");
        cb(err, data);
    }.bind(this));
};

module.exports = SourceCon;
