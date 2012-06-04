
/**
 * Module dependencies.
 */

var express = require('express');
var config = require('./config.json');
var servers = require('./server');
var request = require('request');
var _ = require('underscore');
var socketio = require('socket.io');

var app = module.exports = express.createServer();
var io = socketio.listen(app);
io.set("log level", 0);

// Configuration

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.set('view options', {
    layout: false
  });
  // make a custom html template
  app.register('.html', {
    compile: function(str, options){
      return function(locals){
        return str;
      };
    }
  });
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

app.get('/', function(req, res){
  res.render('index.html');
});

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

// Pad a number with preceding zeroes
var pad = function(number, length) {
    var str = '' + number;
    while (str.length < length) {
        str = '0' + str;
    }
   
    return str;
}

var numNotStarted = numServers;
var sockets = [];
var logs = [];
var peers = [];

var createServer = function(port) {
  senders[port] = createSender(port);
  
  // Create a log function that will generate sortable
  // log data
  var prefix = "[server:" + port + "]";
  var index = 0;
  var log = function() {
      var date = "[" + (new Date()).toISOString() + ":" + pad((++index), 6) + "]";
      var args = _.toArray(arguments);
      args.unshift(prefix + date + "[" + port + "]");
      console.log.apply(console, args);
      
      if(sockets[port]) {
        var socket = sockets[port];
        socket.emit("log", args);
      }
  }
  
  peers.push(port);
  logs.push(log);
  
  servers.create(port, log);
  
  io.of("/" + port)
    .on('connection', function (socket) {
      sockets[port] = socket;
      numNotStarted--;
      
      if (numNotStarted === 0) {
        //start();
      }
      
      socket.on('store', function(data, fn) {
        senders[port](
          "/store",
          data,
          function(err, response, data) {
            console.log(new Date(), data);
            fn(data);
          }
        );
      });
      
      socket.on('fetch', function(data, fn) {
        senders[port](
          "/fetch",
          data,
          function(err, response, data) {
            console.log(new Date(), data);
            fn(data);
          }
        );
      });
      
      socket.on('probability', function(probability) {
        senders[port](
          "/drop",
          {probability: probability}
        );
      });
      
      socket.on('kill', function() {
        senders[port](
          "/drop",
          {probability: 1.0}
        );
      });
      
      socket.on('revive', function() {
        senders[port](
          "/drop",
          {probability: 0.0}
        );
      });
    })
};

_.each(_.range(numServers), function(idx) {
  var port = startPort + idx + 1;
  
  createServer(port);
});

io.sockets.on('connection', function (socket) {
  socket.emit("setup", {ports: peers});
});

var start = null;

// Setup the peers
var setupCompleteCount = numServers;
for(var port in senders) {
  var sender = senders[port];
  sender("/setup", {peers: peers, initialized: true}, function(err, res) {
    setupCompleteCount--;
    if(setupCompleteCount === 0) {
      start2();
    }
  });
}

var removePeers = function(ports, removeFromPort, done) {
  peers = _.difference(peers, ports);
  senders[removeFromPort](
    '/removePeers',
    { peers: ports },
    function(err, response, data) {
      console.log(err, data);
      console.log("-- PEERS REMOVED", ports)   
      done();
    }
  );
};

var addPeer = function(port, joinFromPort, done) {
  createServer(port);
  senders[port]("/setup", {peers: peers, initialized: false}, function(err, res) {
    console.log(" -- PEER", port, "is done setting up");
    
    senders[joinFromPort](
      "/addPeer",
      {
        peer: port
      },
      function(err, response, data) {
        console.log(" -- PEER", port, "is joined");
        if (data) {
          var epoch = data.instance;
          senders[port](
            "/initialize",
            {
              epoch: epoch,
              peers: peers
            },
            function(err, response, data) {
              console.log(" -- AFTER INITIALIZED FOR", port);
              done();
            }
          );
        }
      }
    );
  });
};

var start3 = function() {
  removePeers([peers[2]], peers[0], function() {
    //senders[startPort + 1](
    //  "/store",
    //  {
    //    name: "itay",
    //    value: 600
    //  },
    //  function(err, response, data) {
    //    console.log(new Date(), "---", data);
    //  }
    //);
  });
  
  removePeers([peers[0]], peers[1], function() {
    //senders[startPort + 1](
    //  "/store",
    //  {
    //    name: "itay",
    //    value: 600
    //  },
    //  function(err, response, data) {
    //    console.log(new Date(), "---", data);
    //  }
    //);
  });
};

var start2 = function() {
  var newPeer = startPort + numServers + 1;
  numServers++;
  
  
  senders[peers[0]](
    "/store",
    {
      name: "itay",
      value: 500
    },
    function(err, response, data) {
      console.log(" -- VALUE STORED");
      addPeer(newPeer, peers[0], function() {    
        senders[newPeer](
          "/store",
          {
            name: "itay",
            value: 600
          },
          function(err, response, data) {
            console.log(new Date(), "---", data);
          }
        );
      });
    }
  );
  
  //senders[startPort + 1](
  //  "/store",
  //  {
  //    name: "itay",
  //    value: 600
  //  },
  //  function(err, response, data) {
  //    console.log("-- STORED", data);
  //    addPeer(newPeer, peers[0], function() {    
  //      senders[newPeer](
  //        "/fetch",
  //        {name: "itay", instance: 1},
  //        function(err, response, data) {
  //          console.log(data);
  //        }
  //      );
  //    });
  //  }
  //);
  
  //var newPeer2 = newPeer + 1;
  //addPeer(newPeer2, peers[1], function() {
  //  
  //});
}

start = function() {
  console.log("----- STARTING");
  
  process.nextTick(function() {
    //senders[startPort + 1](
    //  "/store",
    //  {
    //    name: "itay",
    //    value: 500
    //  },
    //  function(err, response, data) {
    //    console.log(new Date(), data);
    //  } 
    //);
    
    process.nextTick(function() {
      senders[startPort + 2](
        "/store",
        {
          name: "itay",
          value: 600
        },
        function(err, response, data) {
          console.log(new Date(), "---", data);
          
          
          //senders[startPort + 2](
          //  "/store",
          //  {
          //    name: "itay",
          //    value: 700
          //  },
          //  function(err, response, data) {
          //    console.log(new Date(), "---", data);
          //  }
          //);
          
          senders[startPort + 1](
            "/fetch",
            {
              name: "itay",
              instance: 1,
              special: true
            },
            function(err, response, data) {
              console.log("FETCH", new Date(), "---", data);
            }
          );
        }
      );
    });
  });
}