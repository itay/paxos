
/**
 * Module dependencies.
 */

var express = require('express');
var config = require('./config.json');
var servers = require('./server');
var request = require('request');

var app = module.exports = express.createServer();

// Configuration

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

var numServers = config.numServers;
var startPort = config.startPort;

app.listen(startPort, function(){
  console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
});

var senders = {};
var createSender = function(port) {
  var host = "http://localhost:" + port;
  return function(path, content, callback) {
    request.post(
      {
        url: host + path,
        json: content
      },
      callback
    );
  };
}

var peers = [];
for(var i = 0; i < numServers; i++) {
  var port = startPort + i + 1;
  senders[port] = createSender(port);
  servers.create(port);
  peers.push(port);
}

var start = null;

// Setup the peers
var setupCompleteCount = numServers;
for(var port in senders) {
  var sender = senders[port];
  sender("/setup", {peers: peers}, function(err, res) {
    setupCompleteCount--;
    if(setupCompleteCount === 0) {
      start();
    }
  });
}

start = function() {
  console.log("----- STARTING");
  
  process.nextTick(function() {
    senders[startPort + 1](
      "/store",
      {
        name: "itay",
        value: 500
      },
      function(err, response, data) {
        console.log(new Date(), data);
      } 
    );
    
    process.nextTick(function() {
      senders[startPort + 2](
        "/store",
        {
          name: "itay",
          value: 600
        },
        function(err, response, data) {
          console.log(new Date(), data);
          
          
          senders[startPort + 2](
            "/store",
            {
              name: "itay",
              value: 700
            },
            function(err, response, data) {
              console.log(new Date(), data);
            }
          );
        }
      );
    });
  });
}