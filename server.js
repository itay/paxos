module.exports.create = function(port) {
    var express = require('express');
    var _ = require('underscore');
    var request = require('request');
    
    var app = module.exports = express.createServer();
    
    function pad(number, length) {
       
        var str = '' + number;
        while (str.length < length) {
            str = '0' + str;
        }
       
        return str;
    
    }

    var dropProbability = 0;
    var prefix = "[server:" + port + "]";
    var index = 0;
    var log = function() {
        var date = "[" + (new Date()).valueOf() + ":" + pad((++index), 6) + "]";
        var args = _.toArray(arguments);
        args.unshift(prefix + date);
        console.log.apply(console, args);
    }

    var shouldDrop = function() {
        return dropProbability >= random;
    }

    function dropPacket(req, res, next) {
      var random = Math.random();
      if (shouldDrop) {
        log("Dropping packet on purpose");
        next(new Error("Dropped packet"));
      }
      else {
        next();
      }
    }
    
    var numPeers = 0;
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
    
    var defer = function(wait, fn) {
        return _.delay(fn, wait);
    }
    
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
    
    // Paxos
    var greaterThan = function(left, right) {
        // A proposal is greater than or equal to another if:
        // 1. it is the same (both the number and peer index are equal)
        // 2. The number is higher
        // 3. The number is the same but the peer is higher
        if (left.number > right.number) {
            return true;
        }
        else if (left.number === right.number && left.peer > right.peer) {
            return true;
        }
        else if (left.number === right.number && left.peer === right.peer) {
            return true;
        }
        else {
            return false;
        }
    };
    
    var proposalStore = {};
    var acceptStore = {};
    var tentativeLearnStore = {};    
    var learnStore = {};    
    var currentInstance = 1;
    
    var proposalTracker = {};
    
    var handlePropose = function(instance, proposal) {
        
        if (acceptStore.hasOwnProperty(instance)) {            
            // We have already accepted something for this
            // instance
            var accepted = acceptStore[instance];
            var acceptedProposal = accepted.proposal;
            var acceptedValue = accepted.value;
            
            // We also need to get our minimum promised proposal
            // number
            var promisedProposal = proposalStore[instance].proposal;
            
            log("  ", "previously accepted:", promisedProposal, "--", acceptedValue);
            
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is higher than our accepted proposal,
                // so we respond with the previously accepted proposal,
                // and the value
                
                // However, we also need to note this new proposal,
                // because we promised not to accept anything less than it
                proposalStore[instance].proposal = proposal;
                
                log("    ", "promising (already accepted)", proposal, " -- ", acceptedValue);
                return {
                    peer: port,
                    promise: true,
                    highestProposal: promisedProposal,
                    value: acceptedValue
                };
            }
            else {
                // This proposal number is less, so we reject it,
                // noting our current highest proposal number and the
                // value we already accepted
                
                log("    ", "rejecting (already accepted)", promisedProposal, " -- ", acceptedValue);
                return {
                    peer: port,
                    promise: false,
                    highestProposal: promisedProposal,
                    value: acceptedValue
                };
            }
        }
        else if (proposalStore.hasOwnProperty(instance)) {
            // We have received a previous proposal for this
            // instance, but we haven't accepted any value yet
            var promisedProposal = proposalStore[instance].proposal;
            
            log("  ", "previously promised:", promisedProposal);
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is igher than our previously
                // promised proposal, so we promise not to accept
                // anything higher than it
                proposalStore[instance].proposal = proposal; 
                
                log("    ", "promising", proposal);
                return {
                    peer: port,
                    promise: true,
                    highestProposal: proposal,
                    value: null
                };
            }
            else {
                // This proposal number is less than the one
                // we promised, so we reject it, and return
                // the one we promised
                
                log("    ", "rejecting", proposal);
                return {
                    peer: port,
                    promise: false,
                    highestProposal: promisedProposal,
                    value: null
                };
            }
        }
        else {
            // This is a brand new instance for us,
            // so we can do whatever we want
            
            // Store that this is the highest proposal number
            // we've seen
            proposalStore[instance] = {
                proposal: proposal,
                value: null
            };
            
            log("  ", "first proposal, accepting", proposal);
            // And return a promise saying we accept it
            return {
                peer: port,
                promise: true,
                highestProposal: proposal,
                value: null
            };
        }
    };
    
    var handleAccept = function(instance, proposal, value) {        
        var promisedProposal = proposalStore[instance].proposal;
        if (greaterThan(proposal, promisedProposal)) {
            // We haven't promised a higher proposal,
            // so we can still accept this request
            log("  ", "beginning to accept");
            
            if (acceptStore.hasOwnProperty(instance)) {
                // We're checking to see if we already accepted
                // something previously. This is just for logging
                // purposes
                var acceptedProposal = acceptStore[instance].proposal;
                var acceptedValue = acceptStore[instance].value;
                
                log("  ", "previously accepted:", acceptedProposal, acceptedValue);
            }
            
            // Store the accepted proposal and value
            // in the accept store
            acceptStore[instance] = {
                proposal: proposal,
                value: value
            };
            
            // Now we need to send out learn requests
            _.each(senders, function(sender) {
                sender(
                    "/learn", 
                    {
                        instance: instance,
                        value: value,
                        peer: port
                    }
                ) 
            });
            return {
                accepted: true,
                peer: port
            };
            
            log("  ", "accepted:", proposal, value);
        }
        else {
            // We've already promised to another higher
            // proposal, so we just do nothing
            log("  ", "rejected:", promisedProposal);
            return {
                accepted: false,
                peer: port
            };
        }
        
    };
    
    var handleLearn = function(instance, value, peer) {        
        if (learnStore.hasOwnProperty(instance)) {
            // We've already fully learned a value,
            // because we received a quorum for it
            log("  ", "ignoring, previously fully learned:", learnStore[instance]);
            return;
        }
        
        var numAcceptors = 0;
        var learned = tentativeLearnStore[instance] = (tentativeLearnStore[instance] || {});
        if (learned.hasOwnProperty(value)) {
            numAcceptors = (++learned[value]);
        }
        else {
            numAcceptors = learned[value] = 1;
        }             
        
        if (numAcceptors >= ((numPeers / 2) + 1)) {
            log("  ", "fully learned:", value);
            learnStore[instance] = value;
            
            if (instance >= currentInstance) {
                log("  ", "setting instance:", instance + 1);
                currentInstance = instance + 1;
            }
        }
    };
    
    // Routes
    
    app.post('/setup', function(req, res) {
        log("received SETUP");
        var peers = req.body.peers;
        for(var i = 0; i < peers.length; i++) {
            var port = peers[i];
            senders[port] = createSender(port);
        }
        
        // Store the number of peers
        numPeers = peers.length;
        
        res.send();
    });
    
    app.post('/drop', function(req, res) {
        log("Drop probability changed from", dropProbability, "to", req.body.dropProbability);
        dropProbability = req.body.dropProbability;
        
        res.send();
    });
    
    var initiateProposal = function(instance, originalValue, finalResponse) {
        var value = originalValue;
        var number = proposalTracker[instance] = (proposalTracker[instance] || 0) + 1;
        var proposal = {
            peer: port,
            number: number
        };
        
        // Function to handle when we receive
        // all accepts or we timeout
        var acceptedResponses = {};
        var acceptTimeoutHandle = null;
        var handleAcceptResponse = function() {
            clearTimeout(acceptTimeoutHandle);
            
            var numAccepted = 0;
            _.each(acceptedResponses, function(response) {
                if (response.accepted) {
                    numAccepted++;
                } 
            });
            
            if (numAccepted >= (numPeers / 2 + 1)) {
                log("  ", "majority accepted", acceptedResponses);
            }
            else {
                log("  ", "majority rejected", acceptedResponses);
                initiateProposal(instance, originalValue, finalResponse);
            }
            acceptedResponses = null;
        };
        
        // Function to handle when we receive
        // all responses or we timeout
        var timeoutHandle = null;
        var received = {};
        var handleProposeResponse = function() {            
            clearTimeout(timeoutHandle);
            
            var highestProposal = { number: -1, peer: -1};
            var highestProposalWithValue = { number: -1, peer: -1};
            var receivedValue = null;
            var numAccepted = 0;
            _.each(received, function(response) {
                if (response.promise) {
                    numAccepted++;
                    if (response.value) {
                        if (greaterThan(response.highestProposal, highestProposalWithValue)) {
                            highestProposalWithValue = response.highestProposal;
                            receivedValue = response.value;
                        }
                    }
                }
                else {
                    if (greaterThan(response.highestProposal, highestProposal)) {
                        highestProposal = response.highestProposal;
                    }
                }
            });
                        
            if (numAccepted >= (numPeers / 2 + 1)) {
                log("Proposal accepted by majority");
                
                if (receivedValue) {
                    log("Using value", receivedValue, "from", highestProposalWithValue.peer);
                    highestProposalWithValue.peer = port;
                    value = receivedValue;
                }
                
                _.each(senders, function(sender) {
                    log("SEND ACCEPT(", instance, ",", proposal, ",", value, ")", "from", port);
                    sender(
                        "/accept",
                        {
                            instance: instance,
                            proposal: proposal,
                            value: value
                        },
                        function(err, response) {
                            log("BEGIN ACCEPT-RESPONSE from", response.body.peer);
                            if (acceptedResponses === null) {
                                log("  ", "ignoring accept-response...");
                                return;
                            }
                            
                            var acceptResponse = response.body;
                            acceptedResponses[acceptResponse.peer] = acceptResponse;
                            log("  ", JSON.stringify(acceptResponse));
                            
                            // Find out if everybody has already responded
                            var acceptedAll = _.keys(acceptedResponses).length === numPeers;
                            if (acceptedAll) {
                                console.log()
                                log("  ", "everybody accept-responded, handling...");
                                handleAcceptResponse();
                            }
                            log("END ACCEPT-RESPONSE");
                        }
                    );
                });
                
                var acceptTimeoutHandle = defer(5000, handleAcceptResponse);
                
                if (value !== originalValue) {
                    // If we changed values, we still need to try and store
                    // the original value the user sent us
                    initiateProposal(currentInstance++, originalValue, finalResponse);
                }
            }
            else {
                log("Proposal rejected, setting new proposal number:", ++highestProposal.number);
                proposalTracker[instance] = highestProposal.number;
                
                // We failed to update because somebody beat us in terms
                // of proposal numbers, so we just try again with a higher
                // proposal number
                initiateProposal(instance, originalValue, finalResponse);
            }
        };
        
        // Send the proposal to each acceptor,
        // and track who answers
        _.each(senders, function(sender) {
            log("SEND PROPOSE(", instance, ",", proposal, ")", "from", port);
            sender(
                "/propose",
                {
                    instance: instance,
                    proposal: proposal
                },
                function(err, response) {
                    log("BEGIN PROPOSE-RESPONSE from", response.body.peer);
                    // If we've already received a majority,
                    // then simply ignore anything else, it's
                    // not important
                    if (received === null) {
                        log("  ", "ignoring...")
                        return;
                    }
                    
                    // Store the response
                    var proposeResponse = response.body;
                    received[proposeResponse.peer] = proposeResponse;
                    log("  ", JSON.stringify(proposeResponse));
                    
                    // Find out if everybody has already responded
                    var receivedAll = _.keys(received).length === numPeers;
                    if (receivedAll) {
                        log("  ", "everybody propose-responded, handling...");
                        handleProposeResponse();
                    }
                    
                    log("END PROPOSE-RESPONSE");
                }
            );
        });
        
        // We wait for 5 seconds before we timeout
        // waiting for the propose-response
        timeoutHandle = defer(5000, handleProposeResponse);
    };
    
    app.post('/store', function(req, res) {
        var data = req.body;
        var value = data.value;
        
        log("Received STORE(", value, ")");
        
        // Get the next proposal number and build the proposal
        var instance = currentInstance++;
        initiateProposal(instance, value, res);
        
        res.send();
    });
    
    app.post('/fetch', function(req, res) {
        res.send(); 
    });
    
    app.post('/propose', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var proposal = data.proposal;
        
        log("BEGIN PROPOSE(", instance, ",", proposal, ")");
        var result = handlePropose(instance, proposal);
        
        res.json(result); 
        log("END PROPOSE");
    });
    
    app.post('/accept', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var proposal = data.proposal;
        var value = data.value;
        
        log("BEGIN ACCEPT(", instance, ",", proposal, ",", value, ")");
        var result = handleAccept(instance, proposal, value);
        
        res.json(result); 
        log("END ACCEPT");
    });
    
    app.post('/learn', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var value = data.value;
        var peer = data.peer;
        
        log("BEGIN LEARN(", instance, ",", value, ",", peer, ")");
        var result = handleLearn(instance, value, peer);
        
        res.json(result); 
        
        log("END LEARN");
    });
    
    app.listen(port, function(){
      console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    });
}