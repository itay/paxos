module.exports.create = function(port) {
    var express = require('express');
    var _       = require('underscore');
    var async   = require('async');
    var request = require('request');
    
    var DROP_PROBABILITY = 0;
    var TIMEOUT_ERROR    = "ETIMEDOUT";
    var REQUEST_TIMEOUT  = 2000;
    var NUM_PEERS        = 0;
    var PEERS            = {};
    
    // Create the app server
    var app = module.exports = express.createServer();
    
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
    
    /****** UTILITY FUNCTIONS ******/
    
    // Pad a number with preceding zeroes
    var pad = function(number, length) {
        var str = '' + number;
        while (str.length < length) {
            str = '0' + str;
        }
       
        return str;
    }
    
    // Create a log function that will generate sortable
    // log data
    var prefix = "[server:" + port + "]";
    var index = 0;
    var log = function() {
        var date = "[" + (new Date()).toISOString() + ":" + pad((++index), 6) + "]";
        var args = _.toArray(arguments);
        args.unshift(prefix + date + "[" + port + "]");
        console.log.apply(console, args);
    }

    // Whether or not we should drop a packet
    var shouldDrop = function() {
        var random = Math.random();
        return DROP_PROBABILITY >= random;
    }

    // Packet dropping middleware
    function dropPacket(req, res, next) {
        if (shouldDrop) {
            log("Dropping packet on purpose");
            next(new Error("Dropped packet"));
        }
        else {
            next();
        }
    }
    
    // Figure out if a proposal is greater than another
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
    
    // Create a local version of a peer,
    // setting up an easy way to send it data
    // with a default timeout
    var createPeer = function(port) {
        var host = "http://localhost:" + port;
        return {
            send: function(path, content, callback) {
                request.post(
                    {
                        url: host + path,
                        json: content,
                        timeout: REQUEST_TIMEOUT
                    },
                    callback
                );
            },
            port: port
        };
    }
    /*******************************/
    /*******************************/
    /*******************************/
    
    /*******************************/
    /******* PAXOS FUNCTIONS *******/
    /*******************************/
    
    // Paxos
    
    // For each (name, instance) pair,
    // store the latest proposal we've
    // promised
    var RECEIVED_PROPOSALS = {};
    
    // For each (name, instance) pair,
    // store the latest (proposal, value)
    // we've accepted.
    var RECEIVED_ACCEPTS = {};
    
    // For each (name, instance) pair,
    // store what value we have learnt
    var LEARNT_VALUES = {};    
    
    var tentativeLearnStore = {};   
    
    // For each name, store what instance
    // number we think we're on
    var CURRENT_INSTANCE = 1;
    
    // For each (name, instance) pair, track
    // what proposal number we should use next
    var PROPOSAL_COUNTER = {};
    
    var handlePropose = function(instance, proposal) {
        
        if (RECEIVED_ACCEPTS.hasOwnProperty(instance)) {            
            // We have already accepted something for this
            // instance
            var accepted = RECEIVED_ACCEPTS[instance];
            var acceptedProposal = accepted.proposal;
            var acceptedValue = accepted.value;
            
            // We also need to get our minimum promised proposal
            // number
            var promisedProposal = RECEIVED_PROPOSALS[instance].proposal;
            
            log("  ", "previously accepted:", promisedProposal, "--", acceptedValue);
            
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is higher than our accepted proposal,
                // so we respond with the previously accepted proposal,
                // and the value
                
                // However, we also need to note this new proposal,
                // because we promised not to accept anything less than it
                RECEIVED_PROPOSALS[instance].proposal = proposal;
                
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
        else if (RECEIVED_PROPOSALS.hasOwnProperty(instance)) {
            // We have received a previous proposal for this
            // instance, but we haven't accepted any value yet
            var promisedProposal = RECEIVED_PROPOSALS[instance].proposal;
            
            log("  ", "previously promised:", promisedProposal);
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is igher than our previously
                // promised proposal, so we promise not to accept
                // anything higher than it
                RECEIVED_PROPOSALS[instance].proposal = proposal; 
                
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
            RECEIVED_PROPOSALS[instance] = {
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
        var promisedProposal = RECEIVED_PROPOSALS[instance].proposal;
        if (greaterThan(proposal, promisedProposal)) {
            // We haven't promised a higher proposal,
            // so we can still accept this request
            log("  ", "beginning to accept");
            
            if (RECEIVED_ACCEPTS.hasOwnProperty(instance)) {
                // We're checking to see if we already accepted
                // something previously. This is just for logging
                // purposes
                var acceptedProposal = RECEIVED_ACCEPTS[instance].proposal;
                var acceptedValue = RECEIVED_ACCEPTS[instance].value;
                
                log("  ", "previously accepted:", acceptedProposal, acceptedValue);
            }
            
            // Store the accepted proposal and value
            // in the accept store
            RECEIVED_ACCEPTS[instance] = {
                proposal: proposal,
                value: value
            };
            
            // Now we need to send out learn requests
            _.each(PEERS, function(peer) {
                peer.send(
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
        if (LEARNT_VALUES.hasOwnProperty(instance)) {
            // We've already fully learned a value,
            // because we received a quorum for it
            log("  ", "ignoring, previously fully learned:", LEARNT_VALUES[instance]);
            return;
        }
        
        // Track how many acceptors accepted
        // a particular value
        var numAcceptors = 0;
        
        // Get the learnt information for this particular instance (or initialize it)
        var learned = tentativeLearnStore[instance] = (tentativeLearnStore[instance] || {});
        if (learned.hasOwnProperty(value)) {
            // We've already seen this value for this instance, so
            // we just increment the value
            numAcceptors = (++learned[value]);
        }
        else {
            // First time we've seen this value, so we set it to 1
            numAcceptors = learned[value] = 1;
        }             
        
        if (numAcceptors >= ((NUM_PEERS / 2) + 1)) {
            // More than half the acceptors have accepted
            // this particular value, so we have now fully
            // learnt it
            log("  ", "fully learned: (", instance, ",", value, ")");
            LEARNT_VALUES[instance] = value;
            
            if (instance >= CURRENT_INSTANCE) {
                // The instance number is higher than the one
                // we have locally, which could happen if we got
                // out of sync. As such, we set our own instance
                // number to one higher.
                log("  ", "setting instance:", instance + 1);
                CURRENT_INSTANCE = instance + 1;
            }
        }
    };
    
    var initiateAccept = function(instance, proposal, value, originalValue, finalResponse) {
        // Create a set of tasks, where each task is sending the ACCEPT
        // message to a specific peer
        var acceptTasks = {};
        _.each(PEERS, function(peer) {
            log("SEND ACCEPT(", instance, ",", proposal, ",", value, ")", "from", port);
            acceptTasks[peer.port] = function(done) {
                peer.send(
                    "/accept",
                    {
                        instance: instance,
                        proposal: proposal,
                        value: value
                    },
                    function(err, response) {
                        var received = null;
                        if (err && err.code === "ETIMEDOUT") {
                            // If we received a timeout, then 
                            // simply mark this, and keep going
                            log("RECEIVED accept-response timeout from", peer.port);
                            received = TIMEOUT_ERROR;
                        }
                        else {
                            // If we received an actual value, then
                            // simply mark this, and keep going
                            log("RECEIVED accept-response from", peer.port);
                            received = response.body;
                        }
                        
                        done(null, received);
                    }
                );
            };
        });

        // Execute all the ACCEPT tasks
        async.parallel(acceptTasks, function(err, accepted) {            
            // Note how many people promised
            var numAccepted = 0;
            _.each(accepted, function(response) {
                if (response === TIMEOUT_ERROR) {
                    return;
                }
                else if (response.accepted) {
                    numAccepted++;
                }
            });
                
            // If less than a majority accepted,
            // then we start over
            if (numAccepted >= (NUM_PEERS / 2 + 1)) {
                log("majority accepted", accepted);
                finalResponse(null, {accepted: true, instance: instance});
            }
            else {
                log("majority rejected", accepted);
                initiateProposal(instance, originalValue, finalResponse);
            }
        });
    };
    
    var initiateProposal = function(instance, originalValue, finalResponse) {
        var value = originalValue;
        var number = PROPOSAL_COUNTER[instance] = (PROPOSAL_COUNTER[instance] || 0) + 1;
        var proposal = {
            peer: port,
            number: number
        };
        
        // Create a set of tasks, where each task is sending the PROPOSE
        // message to a specific peer
        var proposeTasks = {};
        console.log(port, PEERS);
        _.each(PEERS, function(peer) {
            console.log("peer", peer);
            proposeTasks[peer.port] = function(done) {
                log("SEND PROPOSE(", instance, ",", proposal, ")", "from", port);
                peer.send(
                    "/propose",
                    {
                        instance: instance,
                        proposal: proposal
                    },
                    function(err, response) {
                        var received = null;
                        if (err && err.code === TIMEOUT_ERROR) {
                            // If we received a timeout, then 
                            // simply mark this, and keep going
                            log("RECEIVED propose-response timeout from", peer.port);
                            received = TIMEOUT_ERROR;
                        }
                        else {
                            // If we received an actual value, then
                            // simply mark this, and keep going
                            log("RECEIVED propose-response from", peer.port);
                            received = response.body;
                        }
                        
                        done(null, received);
                    }
                );
            };
        });
        
        // Execute all the PROPOSE tasks
        async.parallel(proposeTasks, function(err, received) {
            
            // Keep track of the highest overall proposal
            var highestProposal = { number: -1, peer: -1};
            
            // Keep track of the highest proposal that had a value
            // attached, and the value
            var highestProposalWithValue = { number: -1, peer: -1};
            var newValue = null;
            
            // Note how many people promised
            var numPromised = 0;
            _.each(received, function(response) {
                if (response === TIMEOUT_ERROR) {
                    return;
                }
                else if (response.promise) {
                    // OK, they promised to uphold our proposal
                    numPromised++;
                    
                    if (response.value) {
                        // This response had a value, so we see if it is greater than 
                        // our previous proposal
                        if (greaterThan(response.highestProposal, highestProposalWithValue)) {
                            highestProposalWithValue = response.highestProposal;
                            value = response.value;
                            
                            log("Switching to value", value, "from", highestProposalWithValue.peer);
                        }
                    }
                }
                else {
                    // They rejected our proposal, and so we note what proposal
                    // they return so we can set ours up
                    if (greaterThan(response.highestProposal, highestProposal)) {
                        highestProposal = response.highestProposal;
                    }
                }
            });
                        
            if (numPromised >= (NUM_PEERS / 2 + 1)) {
                // The proposal was accepted by a majority - hurrah!
                // We now send the ACCEPT requests to each acceptor.
                log("Proposal accepted by majority");
                
                if (value !== originalValue) {
                    // If we changed values, we still need to try and store
                    // the original value the user sent us,
                    // so we simply go again
                    initiateProposal(CURRENT_INSTANCE++, originalValue, finalResponse);
                    
                    // We reset the final response in the case where the value changed,
                    // so that we only respond for the original request coming in from the
                    // client, not for this intermediate value we are storing
                    finalResponse = function() {};
                }
                
                // Initiate the ACCEPT phase, but if we changed
                initiateAccept(instance, proposal, value, originalValue, finalResponse);
            }
            else {
                // We failed to update because somebody beat us in terms
                // of proposal numbers, so we just try again with a higher
                // proposal number
                var newNumber = highestProposal.number + 1;
                
                log("Proposal rejected, setting new proposal number:", newNumber);
                PROPOSAL_COUNTER[instance] = newNumber;
                
                initiateProposal(instance, originalValue, finalResponse);
            }
        });
    };
    
    /*******************************/
    /*******************************/
    /*******************************/
    
    // Routes
    
    app.post('/setup', function(req, res) {
        log("received SETUP");
        var peerPorts = req.body.peers;
        for(var i = 0; i < peerPorts.length; i++) {
            var peerPort = peerPorts[i];
            PEERS[peerPort] = createPeer(peerPort);
        }
        
        // Store the number of peers
        NUM_PEERS = peerPorts.length;
        
        res.send();
    });
    
    app.post('/drop', function(req, res) {
        log("Drop probability changed from", DROP_PROBABILITY, "to", req.body.DROP_PROBABILITY);
        DROP_PROBABILITY = req.body.DROP_PROBABILITY;
        
        res.send();
    });
    
    app.post('/store', function(req, res) {
        var data = req.body;
        var value = data.value;
        
        log("Received STORE(", value, ")");
        
        // Get the next proposal number and build the proposal
        var instance = CURRENT_INSTANCE++;
        initiateProposal(instance, value, function(err, result) {
            if (err) {
                res.send(err);
            }
            else {
                res.send(result);
            }
        });
    });
    
    app.post('/fetch', function(req, res) {
        res.send(); 
    });
    
    app.post('/propose', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var proposal = data.proposal;
        
        log("RECEIVE PROPOSE(", instance, ",", proposal, ")");
        var result = handlePropose(instance, proposal);
        
        res.json(result); 
        log("END PROPOSE");
    });
    
    app.post('/accept', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var proposal = data.proposal;
        var value = data.value;
        
        log("RECEIVE ACCEPT(", instance, ",", proposal, ",", value, ")");
        var result = handleAccept(instance, proposal, value);
        
        res.json(result); 
        log("END ACCEPT");
    });
    
    app.post('/learn', function(req, res) {
        var data = req.body;
        var instance = data.instance;
        var value = data.value;
        var peer = data.peer;
        
        log("RECEIVE LEARN(", instance, ",", value, ",", peer, ")");
        var result = handleLearn(instance, value, peer);
        
        res.json(result); 
        
        log("END LEARN");
    });
    
    app.listen(port, function(){
      console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    });
}