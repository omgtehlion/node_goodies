// Code from
// https://github.com/joyent/node/blob/master/lib/http.js
//
var util = require('util');
var net = require('net');
var EventEmitter = require('events').EventEmitter;

// New Agent code.

// The largest departure from the previous implementation is that
// an Agent instance holds connections for a variable number of host:ports.
// Surprisingly, this is still API compatible as far as third parties are
// concerned. The only code that really notices the difference is the
// request object.

// Another departure is that all code related to HTTP parsing is in
// ClientRequest.onSocket(). The Agent is now *strictly*
// concerned with managing a connection pool.

function Agent(options) {
  EventEmitter.call(this);

  var self = this;
  self.options = options || {};
  self.requests = {};
  self.sockets = {};
  self.idleSockets = {};
  self.maxSockets = self.options.maxSockets || Agent.defaultMaxSockets;
  self.keepAlive = self.options.keepAlive || Agent.defaultKeepAlive;
  self.on('free', function(socket, host, port, localAddress) {
    var name = host + ':' + port;
    if (localAddress) {
      name += ':' + localAddress;
    }

    if (!socket.destroyed &&
        self.requests[name] && self.requests[name].length) {
      self.requests[name].shift().onSocket(socket);
      if (self.requests[name].length === 0) {
        // don't leak
        delete self.requests[name];
      }
    } else {
      // If there are no pending requests just destroy the
      // socket and it will get removed from the pool. This
      // gets us out of timeout issues and allows us to
      // default to Connection:keep-alive.
      self.removeFromSockets(socket, name);
      self.putIdleSocket(socket, name);
    }
  });
  self.createConnection = net.createConnection;
}
util.inherits(Agent, EventEmitter);
exports.Agent = Agent;

Agent.defaultMaxSockets = 5;
Agent.defaultKeepAlive = 10 * 1000;

Agent.prototype.defaultPort = 80;
Agent.prototype.addRequest = function(req, host, port, localAddress) {
  var name = host + ':' + port;
  if (localAddress) {
    name += ':' + localAddress;
  }
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }
  if (this.sockets[name].length < this.maxSockets) {
    // If we are under maxSockets create a new one.
    req.onSocket(this.findOrCreateSocket(name, host, port, localAddress, req));
  } else {
    // We are over limit so we'll add it to the queue.
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(req);
  }
};
Agent.prototype.findOrCreateSocket = function(name, host, port, localAddress, req) {
  var idleSocket = this.findIdleSocket(name);
  if (idleSocket) {
    return idleSocket;
  }
  var self = this;
  var options = util._extend({}, self.options);
  options.port = port;
  options.host = host;
  options.localAddress = localAddress;

  options.servername = host;
  if (req) {
    var hostHeader = req.getHeader('host');
    if (hostHeader) {
      options.servername = hostHeader.replace(/:.*$/, '');
    }
  }

  var s = self.createConnection(options);
  if (!self.sockets[name]) {
    self.sockets[name] = [];
  }
  this.sockets[name].push(s);
  var onFree = function() {
    self.emit('free', s, host, port, localAddress);
  }
  s.on('free', onFree);
  var onClose = function(err) {
    // This is the only place where sockets get removed from the Agent.
    // If you want to remove a socket from the pool, just close it.
    // All socket errors end in a close event anyway.
    self.removeSocket(s, name, host, port, localAddress);
  }
  s.on('close', onClose);
  var onRemove = function() {
    // We need this function for cases like HTTP 'upgrade'
    // (defined by WebSockets) where we need to remove a socket from the pool
    //  because it'll be locked up indefinitely
    self.removeSocket(s, name, host, port, localAddress);
    s.removeListener('close', onClose);
    s.removeListener('free', onFree);
    s.removeListener('agentRemove', onRemove);
  }
  s.on('agentRemove', onRemove);
  return s;
};
Agent.prototype.removeSocket = function(s, name, host, port, localAddress) {
  this.removeFromSockets(s, name);
  this.removeFromIdleSockets(s, name);

  if (this.requests[name] && this.requests[name].length) {
    var req = this.requests[name][0];
    // If we have pending requests and a socket gets closed a new one
    this.findOrCreateSocket(name, host, port, localAddress, req).emit('free');
  }
};
Agent.prototype.putIdleSocket = function(socket, name) {
  if (!this.idleSockets[name]) {
    this.idleSockets[name] = [];
  }
  this.idleSockets[name].push({ socket: socket, validTill: +new Date() + this.keepAlive });
  this.setupValidator();
};
Agent.prototype.setupValidator = function() {
  if ("validationTimer" in this) {
    return;
  }
  var self = this;
  this.validationTimer = setTimeout(function() {
    delete self.validationTimer;
    var socketsLeft = 0;
    for (var name in self.idleSockets) if (self.idleSockets.hasOwnProperty(name)) {
      socketsLeft += self.validateIdle(name);
    }
    if (socketsLeft > 0) {
      self.setupValidator();
    }
  }, Math.max(this.keepAlive / 10, 1000));
};
Agent.prototype.findIdleSocket = function(name) {
  if (!this.idleSockets[name] || !this.validateIdle(name)) {
    return null;
  }
  var sobj = this.idleSockets[name].shift();
  if (!sobj) {
    return null;
  }
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }
  this.sockets[name].push(sobj.socket);
  return sobj.socket;
};
Agent.prototype.removeFromSockets = function(s, name) {
  if (this.sockets[name]) {
    var index = this.sockets[name].indexOf(s);
    if (index !== -1) {
      this.sockets[name].splice(index, 1);
      if (this.sockets[name].length === 0) {
        // don't leak
        delete this.sockets[name];
      }
    }
  }
}
Agent.prototype.removeFromIdleSockets = function(s, name) {
  if (this.idleSockets[name]) {
    var index = -1;
    this.idleSockets[name].some(function(sobj, i) {
      if (sobj.socket === s) {
        index = i;
        return true;
      }
      return false;
    });
    if (index !== -1) {
      this.idleSockets[name].splice(index, 1);
      if (this.idleSockets[name].length === 0) {
         // don't leak
         delete this.idleSockets[name];
      }
    }
  }
};
Agent.prototype.validateIdle = function(name) {
  var sockets = this.idleSockets[name];
  var now = +new Date();
  var count = 0;
  sockets.some(function(sobj, i) {
    if (sockets[i].validTill < now) {
      count++;
      return false;
    }
    return true;
  });
  if (count > 0) {
    var removed = sockets.splice(0, count);
    removed.forEach(function(sobj) {
      sobj.socket.destroy();
    });
    if (sockets.length === 0) {
      // don't leak
      delete this.idleSockets[name];
    }
  }
  return sockets.length > 0;
};
