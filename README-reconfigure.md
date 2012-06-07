# Paxos with Reconfiguration - CSEP590 Project 1

This is an implementation of Paxos with Reconfiguration by Itay Neeman (itay) 
for CSEP590.

## Prelude

This README/document builds on `README.md`, which describes requirements, 
installation and general architecture. I will not repeat that information
in this document, because it is for the most part unchanged. All deltas
will be explicitly called out.

## Architecture for Reconfiguration

The basic architecture for handling reconfiguration is just Paxos - we simply
use Paxos to vote on changes to the peer list (two possible actions: add a 
single peer, or remove a set of peers).

As you recall from the first assignment, we maintain state for a set of names,
and a set of consecutive "updates" for each name. In my Paxos implementation,
each update is a Paxos instance, so that a `/store` operation merely assigns
the next available update number, and conflicting numbers are handled by the
consensus algorithm.

Epochs are implemented on top of this mechanism. The peer lists are stored in 
a special name, _EPOCH, and the current peer list (and thus the number required)
to reach a quorum are simply the peer list of the last epoch. As such, if two
separate nodes both try to do an epoch update (e.g. peer A tries to add peer X
and peer B tries to add peer Y in epoch 5) simulatenously, then Paxos  
"trivially" handles this using the consensus algorithm, and only one update
will win epoch 5, and the other update will be forced to go to epoch 6. This
gives us maximum reuse of existing infrastructure, and relegates the changes to
merely handling special cases to do with the epoch updates, rather than any core
algorithm changes.

Similar to how we implemented `/store` and `/fetch` endpoints (and thus 
operations) for clients to call, we now implement `/addPeer` and `/removePeer`
endpoints (and thus operations). They simply take the peer to add or peers to
remove, respectively. For example, here is the core of the implementation
for `/addPeer`:

    app.post('/addPeer', function(req, res) {
        var data = req.body;
        var name = "_EPOCH";
        var peer = data.peer + '';
        
        log("Received ADD_PEER(", peer, ")");
        
        // Mark the current epoch as closed
        EPOCH_CLOSED[GET_CURRENT_EPOCH()] = true;
        
        // Moving epochs is just doing a Paxos instance round on the special
        // name.
        // Get the next proposal number and build the proposal
        var instance = CURRENT_INSTANCE[name]++;
        initiateProposal(name, instance, { add: peer }, function(err, result) {
            // Send result back to client    
        });
    });
    
As you can see, this implementation is very simple, and essentially a special
case of the `/store` endpoint. We merely initiate a proposal for the epoch, and 
then send a response to the client when we are done. Removing a set of peers
is similarly simple.

The logic for the proposer state machine (i.e. propose, wait for responses, 
send accept, wait for responses) is essentially unchanged. We now count the 
number of "errors"/"refusals" due to epoch mismatch, so that they don't count
as a peer being "down". We also store a list of the nodes that were down, and
use that as a mechanism to decide which peers to remove.

Going by the assignment description, here is how we handle each case:

### Failure Detection

Our failure detection mechanism is extremely simple, and builds on functionality
that existed in the previous project. We already know when nodes dropped our
messages and/or timed out while we were waiting for responses. If this happens
during the `PROPOSE` stage, we "forgive" them, and do nothing. However, if
they then do not respond during the `ACCEPT` phase, the proposer will note this,
and as soon as it is done (i.e. it has gotten responses from everyone/timed out)
it will initiate an epoch change to drop those nodes.

Note that we're cheating a bit because we will actually respond with a "drop"
message when we are dropping a message, but even if we didn't, the timeout would
catch any other cases. I decided against a more complex failure detector, 
because any detector is extremely heuristic based, and from experience, simpler
heuristics work better. This also did not seem like the interesting part of the
assignment.

### Node Removal and Node Addition

There is no difference from the epoch mechanism's point of view to whether we
are adding or removing nodes. Even if the failure detector detected inconsistent
states, or inconsistent requests were sent from clients (e.g. node A tries to 
remove node B while node B tries to remove node A), the Paxos consensus
mechanism deals with it - only one change will win, and the losing one will
be attempted at the next epoch. If the change is no longer consistent (e.g. 
node A removed node B, and now node B tries again to remove node A) because the
proposer is no longer in the peer set, then that change is rejected.

One interesting thing is that I implemented the "value" being agreed on as 
as a delta (e.g. +X, or -(X,Y)), rather than sending the entire new list. This
is to deal with the case of competing changes: if we start with (A,B,C) and we
have to competing proposals to add X and add Y, then one proposal will be 
(A,B,C,X) and the other (A,B,C,Y). One will lose, by definition, and will
reattempt, but it now contains stale information. Instead, we simply set deltas,
and those deltas are combined with the peer set of the previous epoch, thus
allowing us to reliably add/remove nodes.

### State Transfer

State transfer isn't quite implemented per se. What I ended up doing was saying
that a new peer cannot participate in any vote that is in a previous epoch. For
example, if node X gets added to the peer set, and it suddenly receives a
lingering message from a previous epoch, it will not vote on it. Similarily, it
will automatically reject any proposals from any node for an epoch that that 
node wasn't part of (e.g. if node X tries to propose something for the epoch
being they joined, node A will reject all such proposals).

State transfer, in the above world, amounts to simply telling a node which epoch
it joined in. What we do is when a node is "created" (i.e. its HTTP server is 
started), it is not yet initialized, meaning it rejects any incoming messages.
Once the current Paxos peer set agrees on adding that node, it gets the
initialize message with its peer set, and which epoch it joined in. The
implementation looks like this:

    app.post('/initialize', function(req, res) {
        var epoch = req.body.epoch;
        var peerPorts = req.body.peers;
        
        // This endpoint is basically a way to distinguish between an epoch
        // becoming alive (which can happen at an arbitrary point in time), 
        // and an epoch joining the set of peers (i.e. it has been accepted
        // through a Paxos vote). This is essentially equivalent to the state
        // transfer - we simply note what epoch we joined in, and we avoid
        // participating in anything in a prior epoch.
        
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
        
        // Create the peer senders for this epoch, and store them
        var peers = {};
        for(var i = 0; i < peerPorts.length; i++) {
            var peerPort = peerPorts[i];
            peers[peerPort] = createPeer(peerPort);
        }
        FULLY_LEARNT_VALUES["_EPOCH"][epoch] = peers;
        
        // Mark ourselves as being part of this epoch
        WAS_IN_EPOCH[epoch] = true;
        
        res.send();
    });
    
