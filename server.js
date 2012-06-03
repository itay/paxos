module.exports.create = function(port, log) {
    var express = require('express');
    var _       = require('underscore');
    var async   = require('async');
    var request = require('request');
    
    var DROP_PROBABILITY = 0.0;
    var DROPPED_ERROR    = "DROPPEDPACKET";
    var TIMEOUT_ERROR    = "ETIMEDOUT";
    var PEERS_DOWN       = {accepted: false, message: "PEERS ARE DOWN"};
    var REQUEST_TIMEOUT  = 2000;
    var NUM_PEERS        = 0;
    var PEERS            = {};
    var NO_VALUE         = "__0xDEADBEEF";
    var TEST_VALUE       = "__0xBEEFDEAD";
    var NOT_IN_EPOCH     = "__NOT_IN_EPOCH";
    var VALUE_NOT_FOUND  = "NO VALUE FOUND";
    var LEARN_TIMEOUT    = 2000;
    
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

    // Whether or not we should drop a packet
    var shouldDrop = function() {
        var random = Math.random();
        return DROP_PROBABILITY >= random;
    }

    // Packet dropping middleware
    function dropPacket(req, res, next) {
        if (shouldDrop()) {
            log("Dropping packet on purpose");
            next(DROPPED_ERROR);
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
         
        if (left.epoch < right.epoch) {
            return false;
        }
        
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
                    function(err, response) {
                        callback = callback || function() {};
                        if(shouldDrop()) {
                            log("Dropping packet on purpose");
                            callback(null, {body: {error: DROPPED_ERROR}});
                        }
                        else {
                            callback(err, response);
                        }
                    }
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
    var FULLY_LEARNT_VALUES = {};    
    
    // For each (name, instance) pair,
    // keep track of how many times we've
    // learnt some value, so we know
    // when a majority of acceptors
    // has accepted a single value
    var TENTATIVELY_FULLY_LEARNT_VALUES = {};   
    
    var FULLY_LEARNT_LISTENERS = {};
    
    // For each name, store what instance
    // number we think we're on
    var CURRENT_INSTANCE = {};
    
    // For each (name, instance) pair, track
    // what proposal number we should use next
    var PROPOSAL_COUNTER = {};
    
    // Store whether a particular epoch is closed
    var EPOCH_CLOSED = {};
    
    // Store whether or not we were part of a particular epoch
    var WAS_IN_EPOCH = {};
    
    // Store whether or not we are initialized
    var INITIALIZED = true;
    
    var GET_CURRENT_EPOCH = function() {
        var epochs = _.keys(FULLY_LEARNT_VALUES["_EPOCH"]) || [];
        epochs.sort();
        
        return epochs[epochs.length - 1];
    };
    
    var GET_PEERS = function() {
        var currentEpoch = GET_CURRENT_EPOCH();
        var peers = FULLY_LEARNT_VALUES["_EPOCH"][currentEpoch];
        
        return peers;
    };
    
    var GET_NUM_PEERS = function() { 
        var peers = GET_PEERS() || {};
        return _.keys(peers).length;
    };
    
    var IS_IN_EPOCH = function(peer) { 
        var peers = GET_PEERS();
        
        // A peer is not in the epoch if it is not initialized
        return INITIALIZED && _.keys(peers).indexOf(peer + '') >= 0;
    };
    
    var IS_EPOCH_CLOSED = function() {
        var currentEpoch = GET_CURRENT_EPOCH();
        return !!EPOCH_CLOSED[currentEpoch];
    };
    
    var handlePropose = function(name, instance, proposal) {
        if (!WAS_IN_EPOCH[proposal.epoch] || !IS_IN_EPOCH(proposal.peer)) {
            log("  ", proposal.peer, "not in epoch");
            return {
                name: name,
                peer: port,
                promise: false,
                epoch: false
            };
        }
        
        if (RECEIVED_ACCEPTS[name].hasOwnProperty(instance)) {
            // We have already accepted something for this
            // instance
            var accepted = RECEIVED_ACCEPTS[name][instance];
            var acceptedProposal = accepted.proposal;
            var acceptedValue = accepted.value;
            
            // We also need to get our minimum promised proposal
            // number
            var promisedProposal = RECEIVED_PROPOSALS[name][instance].proposal;
            
            log("  ", "previously accepted:", promisedProposal, "--", acceptedValue);
            
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is higher than our accepted proposal,
                // so we respond with the previously accepted proposal,
                // and the value
                
                // However, we also need to note this new proposal,
                // because we promised not to accept anything less than it
                RECEIVED_PROPOSALS[name][instance].proposal = proposal;
                
                log("    ", "promising (already accepted)", proposal, " -- ", acceptedValue);
                return {
                    name: name,
                    peer: port,
                    promise: true,
                    epoch: true,
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
                    name: name,
                    peer: port,
                    promise: false,
                    epoch: true,
                    highestProposal: promisedProposal,
                    value: acceptedValue
                };
            }
        }
        else if (RECEIVED_PROPOSALS[name].hasOwnProperty(instance)) {
            // We have received a previous proposal for this
            // instance, but we haven't accepted any value yet
            var promisedProposal = RECEIVED_PROPOSALS[name][instance].proposal;
            
            log("  ", "previously promised:", promisedProposal);
            if (greaterThan(proposal, promisedProposal)) {
                // The proposal is igher than our previously
                // promised proposal, so we promise not to accept
                // anything higher than it
                RECEIVED_PROPOSALS[name][instance].proposal = proposal; 
                
                log("    ", "promising", proposal);
                return {
                    name: name,
                    peer: port,
                    promise: true,
                    epoch: true,
                    highestProposal: proposal,
                    value: NO_VALUE
                };
            }
            else {
                // This proposal number is less than the one
                // we promised, so we reject it, and return
                // the one we promised
                
                log("    ", "rejecting", proposal);
                return {
                    name: name,
                    peer: port,
                    promise: false,
                    epoch: true,
                    highestProposal: promisedProposal,
                    value: NO_VALUE
                };
            }
        }
        else {
            // This is a brand new instance for us,
            // so we can do whatever we want
            
            // If the epoch is already closed, then we always reject
            if (IS_EPOCH_CLOSED() && name !== "_EPOCH") {
                log("  ", "rejecting proposal because epoch is closed");
                return {
                    name: name,
                    peer: port,
                    promise: false,
                    epoch: false
                }
            }
            
            // Store that this is the highest proposal number
            // we've seen
            RECEIVED_PROPOSALS[name][instance] = {
                proposal: proposal,
                value: NO_VALUE
            };
            
            log("  ", "first proposal, accepting", proposal);
            // And return a promise saying we accept it
            return {
                name: name,
                peer: port,
                promise: true,
                epoch: true,
                highestProposal: proposal,
                value: NO_VALUE
            };
        }
    };
    
    var handleAccept = function(name, instance, proposal, value) {        
        if (!WAS_IN_EPOCH[proposal.epoch] || !IS_IN_EPOCH(proposal.peer)) {
            log("  ", proposal.peer, "not in epoch");
            return {
                accepted: false,
                epoch: false,
                peer: port
            };
        }
        
        //console.error(port, arguments);
        var promisedProposal = RECEIVED_PROPOSALS[name][instance].proposal;
        //console.error("-----");
        if (greaterThan(proposal, promisedProposal)) {
            // We haven't promised a higher proposal,
            // so we can still accept this request
            log("  ", "beginning to accept");
            
            if (RECEIVED_ACCEPTS[name].hasOwnProperty(instance)) {
                // We're checking to see if we already accepted
                // something previously. This is just for logging
                // purposes
                var acceptedProposal = RECEIVED_ACCEPTS[name][instance].proposal;
                var acceptedValue = RECEIVED_ACCEPTS[name][instance].value;
                
                log("  ", "previously accepted:", acceptedProposal, acceptedValue);
            }
            
            // Store the accepted proposal and value
            // in the accept store
            RECEIVED_ACCEPTS[name][instance] = {
                proposal: proposal,
                value: value
            };
            
            // Now we need to send out learn requests
            _.each(GET_PEERS(), function(peer) {
                peer.send(
                    "/learn", 
                    {
                        name: name,
                        instance: instance,
                        value: value,
                        peer: port
                    }
                ) 
            });
            return {
                accepted: true,
                epoch: true,
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
                epoch: true,
                peer: port
            };
        }
        
    };
    
    var handleLearn = function(name, instance, value, peer) {        
        if (FULLY_LEARNT_VALUES[name].hasOwnProperty(instance)) {
            // We've already fully learned a value,
            // because we received a quorum for it
            log("  ", "ignoring, previously fully learned:", name, FULLY_LEARNT_VALUES[name][instance]);
            return;
        }
        
        // Track how many acceptors accepted
        // a particular value
        var numAcceptors = 0;
        
        // Get the learnt information for this particular instance (or initialize it)
        var learned = TENTATIVELY_FULLY_LEARNT_VALUES[name][instance] = (TENTATIVELY_FULLY_LEARNT_VALUES[name][instance] || {});
        if (learned.hasOwnProperty(value)) {
            // We've already seen this value for this instance, so
            // we just increment the value
            numAcceptors = (++learned[value]);
        }
        else {
            // First time we've seen this value, so we set it to 1
            numAcceptors = learned[value] = 1;
        }             
        
        if (numAcceptors >= Math.floor((GET_NUM_PEERS() / 2) + 1)) {
            // More than half the acceptors have accepted
            // this particular value, so we have now fully
            // learnt it
            log("  ", "fully learned: (", name, ",", instance, ",", value, ")");
            FULLY_LEARNT_VALUES[name][instance] = value;
            
            if (instance >= CURRENT_INSTANCE[name]) {
                // The instance number is higher than the one
                // we have locally, which could happen if we got
                // out of sync. As such, we set our own instance
                // number to one higher.
                log("  ", "setting instance:", instance + 1);
                CURRENT_INSTANCE[name] = instance + 1;
            }
            
            if (FULLY_LEARNT_LISTENERS[name][instance] !== null) {
                _.each(FULLY_LEARNT_LISTENERS[name][instance], function(listener) {
                    log("  ", "dispatching to listener");
                    listener(value); 
                });
                FULLY_LEARNT_LISTENERS[name][instance] = null;
            }
            
            if (name === "_EPOCH") {
                log("  ", "learnt new epoch, setting up peers");
                
                var currentPeers = _.keys(FULLY_LEARNT_VALUES["_EPOCH"][instance-1]);
                var newPeerSet = currentPeers;
                if (value.add) {
                    var newPeer = value.add;
                    
                    newPeerSet.push(newPeer);
                }
                else {
                    var peersToRemove = value.remove;
                    newPeerSet = _.difference(newPeerSet, peersToRemove);
                }
                
                var peers = {};
                for(var i = 0; i < newPeerSet.length; i++) {
                    var peerPort = newPeerSet[i];
                    peers[peerPort] = createPeer(peerPort);
                }
                FULLY_LEARNT_VALUES[name][instance] = peers;
                WAS_IN_EPOCH[instance] = true;
                
                log("  ", "new peer set:" , newPeerSet);
            }
        }
    };
    
    var initiateAccept = function(name, instance, proposal, value, originalValue, finalResponse) {
        // Create a set of tasks, where each task is sending the ACCEPT
        // message to a specific peer
        var acceptTasks = {};
        _.each(GET_PEERS(), function(peer) {
            log("SEND ACCEPT(", name, ",", instance, ",", proposal, ",", value, ")", "from", port);
            acceptTasks[peer.port] = function(done) {
                peer.send(
                    "/accept",
                    {
                        name: name,
                        instance: instance,
                        proposal: proposal,
                        value: value
                    },
                    function(err, response) {
                        var received = null;
                        if (err && err.code === TIMEOUT_ERROR) {
                            // If we received a timeout, then 
                            // simply mark this, and keep going
                            log("RECEIVED accept-response timeout from", peer.port);
                            received = TIMEOUT_ERROR;
                        }
                        else if (response.body.error === DROPPED_ERROR) {
                            // If we received a drop message response,
                            // then simply mark this, and keep going
                            log("RECEIVED accept-response drop from", peer.port);
                            received = DROPPED_ERROR;
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
            var numPeersDown = 0;
            var numEpochs = 0;
            _.each(accepted, function(response) {
                if (response === TIMEOUT_ERROR || response === DROPPED_ERROR) {
                    // Let's count how many people died on us, so we know
                    // whether we should keep trying or if this is a catastrophic
                    // failure
                    numPeersDown++;
                    return;
                }
                else if (response.accepted) {
                    numAccepted++;
                }
                else if (!response.epoch) {
                    numEpochs++;
                }
            });
                
            // If less than a majority accepted,
            // then we start over
            if (numAccepted >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                log("majority accepted", accepted);
                finalResponse(null, {accepted: true, instance: instance});
            }
            else if (numPeersDown >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                // This is a catastrophic failure, let's cut our losses
                // More than half our peers seem to be down, so we just
                // respond to the client immediately
                finalResponse(PEERS_DOWN);
            }
            else if (numPeersDown >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                finalResponse(NOT_IN_EPOCH);   
            }
            else {
                log("majority rejected", accepted);
                initiateProposal(name, instance, originalValue, finalResponse);
            }
        });
    };
    
    var initiateProposal = function(name, instance, originalValue, finalResponse) {
        var value = originalValue;
        var number = PROPOSAL_COUNTER[instance] = (PROPOSAL_COUNTER[instance] || 0) + 1;
        var proposal = {
            peer: port,
            number: number,
            epoch: GET_CURRENT_EPOCH()
        };
        
        // Create a set of tasks, where each task is sending the PROPOSE
        // message to a specific peer
        var proposeTasks = {};
        _.each(GET_PEERS(), function(peer) {
            proposeTasks[peer.port] = function(done) {
                log("SEND PROPOSE(", name, ",", instance, ",", proposal, ")", "from", port, "to", peer.port);
                peer.send(
                    "/propose",
                    {
                        name: name,
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
                        else if (response.body.error === DROPPED_ERROR) {
                            // If we received a drop message response,
                            // then simply mark this, and keep going
                            log("RECEIVED propose-response drop from", peer.port);
                            received = DROPPED_ERROR;
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
            var numPeersDown = 0;
            var numEpochs = 0;
            _.each(received, function(response) {
                if (response === TIMEOUT_ERROR || response === DROPPED_ERROR) {
                    // Let's count how many people died on us, so we know
                    // whether we should keep trying or if this is a catastrophic
                    // failure
                    numPeersDown++;
                    return;
                }
                else if (response.promise) {
                    // OK, they promised to uphold our proposal
                    numPromised++;
                    
                    if (response.value !== NO_VALUE) {
                        // This response had a value, so we see if it is greater than 
                        // our previous proposal
                        if (greaterThan(response.highestProposal, highestProposalWithValue)) {
                            highestProposalWithValue = response.highestProposal;
                            value = response.value;
                            
                            log("Switching to value", value, "from", highestProposalWithValue.peer);
                        }
                    }
                }
                else if (!response.epoch) {
                    // Our proposal was rejected because of epoch differences,
                    // so we simply do nothing with this resposne.
                    numEpochs++;
                }
                else {
                    // They rejected our proposal, and so we note what proposal
                    // they return so we can set ours up
                    console.log(response);
                    if (greaterThan(response.highestProposal, highestProposal)) {
                        highestProposal = response.highestProposal;
                    }
                }
            });
            
            if (numPromised >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                // The proposal was accepted by a majority - hurrah!
                // We now send the ACCEPT requests to each acceptor.
                log("Proposal accepted by majority");
                
                if (value !== originalValue && originalValue !== TEST_VALUE) {
                    // If we changed values, we still need to try and store
                    // the original value the user sent us,
                    // so we simply go again
                    initiateProposal(name, CURRENT_INSTANCE[name]++, originalValue, finalResponse);
                    
                    // We reset the final response in the case where the value changed,
                    // so that we only respond for the original request coming in from the
                    // client, not for this intermediate value we are storing
                    finalResponse = function() {};
                }
                else if (value !== originalValue && originalValue === TEST_VALUE) {
                    // If the original value is null and the proposal was promised,
                    // then we don't want to initiate a new proposal for the TEST_VALUE value,
                    // and we don't want to do anything for the new value, as we
                    // will simply learn it
                    finalResponse = function() {};
                }
                else if (originalValue === TEST_VALUE && value === TEST_VALUE) {
                    // If this is a test value (because we're trying to force a learn cycle),
                    // and our value was accepted just like that, then we simply
                    // return that there is no value, and short circuit
                    finalResponse(null, VALUE_NOT_FOUND);
                    return;
                }
                
                // Initiate the ACCEPT phase, but if we changed
                initiateAccept(name, instance, proposal, value, originalValue, finalResponse);
            }
            else if (numPeersDown >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                // This is a catastrophic failure, let's cut our losses
                // More than half our peers seem to be down, so we just
                // respond to the client immediately
                finalResponse(PEERS_DOWN);
            }
            else if (numEpochs >= Math.floor(GET_NUM_PEERS() / 2 + 1)) {
                // More than half the responses were due to out of epoch 
                // cases, so we return that
                finalResponse(NOT_IN_EPOCH);
            }
            else {
                // We failed to update because somebody beat us in terms
                // of proposal numbers, so we just try again with a higher
                // proposal number
                var newNumber = highestProposal.number + 1;
                
                log("Proposal rejected, setting new proposal number:", newNumber);
                PROPOSAL_COUNTER[instance] = newNumber;
                
                initiateProposal(name, instance, originalValue, finalResponse);
            }
        });
    };
    
    var initializeStorageForName = function(name) {
        // If we haven't seen this name before,
        // then we initialize all our storage for it
        if (!RECEIVED_PROPOSALS.hasOwnProperty(name)) {
            log("INITIALIZED STORAGE FOR", name);
            RECEIVED_PROPOSALS[name] = {};
            RECEIVED_ACCEPTS[name] = {};
            FULLY_LEARNT_VALUES[name] = {};
            TENTATIVELY_FULLY_LEARNT_VALUES[name] = {};
            CURRENT_INSTANCE[name] = 1;
            FULLY_LEARNT_LISTENERS[name] = {};
        }
    };
    
    /*******************************/
    /*******************************/
    /*******************************/
    
    // Routes
    
    app.post('/setup', function(req, res) {
        log("received SETUP");
        var peerPorts = req.body.peers;
        var peers = {};
        for(var i = 0; i < peerPorts.length; i++) {
            var peerPort = peerPorts[i];
            peers[peerPort] = createPeer(peerPort);
        }
        
        initializeStorageForName("_EPOCH");
        FULLY_LEARNT_VALUES["_EPOCH"][0] = peers;
        WAS_IN_EPOCH[0] = true;
        
        if (!req.body.initialized) {
            INITIALIZED = false;
        }
        
        res.send();
    });
    
    app.post('/drop', function(req, res) {
        log("Drop probability changed from", DROP_PROBABILITY, "to", req.body.probability);
        DROP_PROBABILITY = req.body.probability;
        
        res.send();
    });
    
    app.post('/addPeer', function(req, res) {
        var data = req.body;
        var name = "_EPOCH";
        var peer = data.peer + '';
        
        log("Received ADD_PEER(", peer, ")");
        
        var peers = _.keys(GET_PEERS());
        
        // Mark the current epoch as closed
        EPOCH_CLOSED[GET_CURRENT_EPOCH()] = true;
        
        // Get the next proposal number and build the proposal
        var instance = CURRENT_INSTANCE[name]++;
        initiateProposal(name, instance, { add: peer }, function(err, result) {
            if (err) {
                // If there was an error, let's make it as if this never
                // never happened
                CURRENT_INSTANCE[name]--;
                delete PROPOSAL_COUNTER[name];
                
                res.json(err);
            }
            else {
                res.json(result);
            }
        });
    });
    
    app.post('/initialize', function(req, res) {
        var epoch = req.body.epoch;
        var peerPorts = req.body.peers;
        
        log("INITIALIZING", port, req.body);
        
        // Mark us as initialized
        INITIALIZED = true;
        
        // Mark all the epochs before the one we joined in as closed, because
        // we shouldn't participate in any decisions for epochs prior to us
        // joining
        EPOCH_CLOSED = {};
        for(var i = 0; i < epoch; i++) {
            EPOCH_CLOSED[i] = true;
            WAS_IN_EPOCH[i] = false;
        } 
        
        var peers = {};
        for(var i = 0; i < peerPorts.length; i++) {
            var peerPort = peerPorts[i];
            peers[peerPort] = createPeer(peerPort);
        }
        FULLY_LEARNT_VALUES["_EPOCH"][epoch] = peers;
        WAS_IN_EPOCH[epoch] = true;
        
        res.send();
    });
    
    app.post('/store', function(req, res) {
        var data = req.body;
        var name = data.name;
        var value = data.value;
        
        log("Received STORE(", name, ",", value, ")");
        
        // Initialize our storage for this name
        initializeStorageForName(name);
        
        // Get the next proposal number and build the proposal
        var instance = CURRENT_INSTANCE[name]++;
        initiateProposal(name, instance, value, function(err, result) {
            if (err) {
                // If there was an error, let's make it as if this never
                // never happened
                CURRENT_INSTANCE[name]--;
                delete PROPOSAL_COUNTER[name];
                
                res.json(err);
            }
            else {
                res.json(result);
            }
        });
    });
    
    app.post('/fetch', function(req, res) {
        var data = req.body;
        var name = data.name;
        var instance = data.instance;
        
        log("Received FETCH(", name, ",", instance, ")");
        
        // Initialize our storage for this name
        initializeStorageForName(name);
        
        if (FULLY_LEARNT_VALUES[name][instance] !== null && FULLY_LEARNT_VALUES[name][instance] !== undefined) {
            log("FETCH SHORTCIRCUIT")
            // If we have a fully learnt value, we don't need to
            // do a paxos round 
            res.json({
                found: true,
                name: name, 
                instance: instance, 
                value: FULLY_LEARNT_VALUES[name][instance]
            });
        }
        else {
            // We need to queue up a listener when we've fully learnt the 
            // value
            var listeners = FULLY_LEARNT_LISTENERS[name][instance] = (FULLY_LEARNT_LISTENERS[name][instance] || []);
            listeners.push(function(value) {
                if (res !== null) {
                    log("FETCH listener invoked!");
                    res.json({
                        found: true,
                        name: name,
                        instance: instance,
                        value: value
                    });
                }
                else {
                    log("FETCH listener invoked too late!")
                }
            });
            
            setTimeout(LEARN_TIMEOUT, function() {
                log("FETCH timeout!");
                res.json({
                    found: false,
                    name: name,
                    instance: instance,
                    message: "Timeout"
                });
                
                res = null;
            });
            
            // OK, we don't have a value, so we initiate a round for this
            // (name, instance) pair.
            initiateProposal(name, instance, TEST_VALUE, function(err, result) {
                if (err) {
                    res.json(err);
                }
                else {
                    if (result === VALUE_NOT_FOUND) {
                        res.send({found: false}, 404)
                    }
                    else {
                        res.send({found: false, message: "WTF: " + result}, 500);
                    }
                }
                
                res = null;
            });
        }
    });
    
    app.post('/propose', dropPacket, function(req, res) {
        var data = req.body;
        var name = data.name;
        var instance = data.instance;
        var proposal = data.proposal;
        
        log("RECEIVE PROPOSE(", name, ",", instance, ",", proposal, ")");
        
        if (name === "_EPOCH") {
            log("  ", "closing down epoch");
            EPOCH_CLOSED[GET_CURRENT_EPOCH()] = true;
        }
        
        // Initialize our storage for this name
        initializeStorageForName(name);
        
        var result = handlePropose(name, instance, proposal);
        
        if (shouldDrop()) {
            log("Dropping packet on purpose");
            throw DROPPED_ERROR;
        }
        else {
            res.json(result);
        }
        log("END PROPOSE");
    });
    
    app.post('/accept', dropPacket, function(req, res) {
        var data = req.body;
        var name = data.name;
        var instance = data.instance;
        var proposal = data.proposal;
        var value = data.value;
        
        log("RECEIVE ACCEPT(", name, ",", instance, ",", proposal, ",", value, ")");
        
        if (name === "_EPOCH") {
            log("  ", "closing down epoch");
            EPOCH_CLOSED[GET_CURRENT_EPOCH()] = true;
        }
        
        // Initialize our storage for this name
        initializeStorageForName(name);
        
        var result = handleAccept(name, instance, proposal, value);
        
        if (shouldDrop()) {
            log("Dropping packet on purpose");
            throw DROPPED_ERROR;
        }
        else {
            res.json(result);
        }
        
        log("END ACCEPT");
    });
    
    app.post('/learn', dropPacket, function(req, res) {
        var data = req.body;
        var name = data.name;
        var instance = data.instance;
        var value = data.value;
        var peer = data.peer;
        
        log("RECEIVE LEARN(", name, ",", instance, ",", value, ",", peer, ")");
        
        // Initialize our storage for this name
        initializeStorageForName(name);
        
        var result = handleLearn(name, instance, value, peer);
        
        if (shouldDrop()) {
            log("Dropping packet on purpose");
            throw DROPPED_ERROR;
        }
        else {
            res.json(result);
        }
        
        log("END LEARN");
    });
    
    app.listen(port, function(){
      console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    });
}