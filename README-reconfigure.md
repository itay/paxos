# Paxos with Reconfiguration - CSEP590 Project 2

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
    
The above mechanism allows us to need to transfer as little state as possible,
and the new node is functional as soon as it receives the `/initialize` command:
it can now store and fetch values, even values from instances that it did not 
know about. This is because "fetches" occur by simulating a Paxos instance, 
which happen in the current epoch, so participation is allowed.
    
### Other architectural notes

There were a couple of other small notes that I thought are worth mentioning:

#### Epochs get closed

As soon as a peer gets an epoch related message (i.e. any Paxos message for the 
name _EPOCH), it marks its epoch as closed. This has a single effect: any
proposals for a new instance are automatically rejected. This allows us to
continue operating on previous rounds, but not start any new rounds.

#### Learning new peer sets

The learning mechanism has not changed, but the learner logic does recognize
that it is learning a peer set, and does some extra transformation on the 
values. For example, it will apply the delta to the previous peer set (as noted
above). It will also initialize utility functions to send data to each of the
peers. This is only done when a value is fully learnt (reusing the definition
from the first assignment).

#### Accepting an unseen proposal

The implementation led itself to an interesting edge condition. Imagine that you
have peers A,B,C. B wants to add node Y, so it marks its epoch as closed, and
initiates an epoch Paxos instance by sending PROPOSE messages to A, B and C. At
the same time, A wants to store value 1234 for some name (say FOO), which it also
does by initiating a Paxos instance for that name. Say A and C get the 
PROPOSE(INSTANCE=1, PROPOSAL=1, VALUE=1234) before they receive the ADD_NODE
proposal from B, and they promise to honor it. When B receives it of course 
rejects it, as the epoch is already closed as far as it is concerned. However,
since a quorum returned positive promises to the proposal, A goes ahead to send
ACCEPT messages to the three nodes. As such, B now gets an ACCEPT message for
a proposal it has never seen before, so it may get confused (and indeed it did!).

The solution here is to basically say that an unseen proposal is equal to the
minimum possible one (PEER=-1, PROPOSAL=-1), and so we should automatically
accept it and send back a positive acceptance. This is because this proposal
managed to "sneak" in while the epoch change was under way, which is perfectly
reasonable, and this has no effect on correctness. I thought this was an
interesting condition.

## Known Issues

I actually fixed an issue I thought I had in my previous implementation where I 
thought that I was skipping instance numbers. Turned out this was just due to
JS type coercion, so while a bug, it was not a Paxos logic bug.

There is one known issue that I want to point to: while nodes competing with 
each other works just fine (i.e. nodes can both propose values, or change the
epoch), and only one winner will be chosen, if a node tries to compete with
itself, bad things may happen.

This happens because of how I implemented Paxos. Specifically, when a `/store`,
`/addPeer` or `/removePeers` command is received, we opportunistically assign
it the current instance and increment our instance counter. However, if two
commands come to the same node before the other succeeded, and the earlier
command fails, we will get into a case where we have a "hole" in our instance
numbers (i.e. an instance with no value assigned to it). This is not a 
correctness issue, but my implementation assumed that this would not be the
case, and such can't handle those holes. 

As such, try not to perform a `/store` on the same node before the previous one
succeeded. As noted, two nodes can compete just fine. The fix here is relatively
simple, but I figured this out relatively late and it didn't seem it was worth
the risk of fixing it (as it would be a relatively intrusive change).

I have tested adding/removing nodes at the same time as storing (with both 
orderings), adding two nodes simulatenously through different existing peers,
conflicting removals, conflicting add/remove (e.g. node X adding Y, node Z 
removing X), and everything works just fine, just because Paxos works and
ensures that only one winner is chosen.

## UI

As before, adding and removing nodes can be done through the UI. To add a node,
simply enter a port number of the peer you want to add. That peer will be 
instanced dynamically and added (you can see the Paxos logs to see how this 
works). To remove a single node, you can simply choose to remove it from the UI
as well by entering the port number.

You can also remove multiple nodes at once by "killing" them in the UI, and then
sending a store or fetch request from the UI. The failure detector will kick in,
and remove all the dead nodes. 

Note that while I've tested adding/removing the same node over and over again,
it's always possible that the OS will not be happy about the port reuse and 
might give an error, so I suggest using incrementing port numbers.

## Testing

I've tested the implementation beyond the UI, but I kept changing the tests
(i.e. just changing a single test - bad software engineering, I know!), so
it's not really a runnable test suite. It is hard to test from the UI what 
happens from competing nodes. You can see an example for these tests by 
looking for the line "UNCOMMENT", and commenting the preceding line - it will
run a test that will have two node adds happening simulatenously from different
origin nodes.

## Questions

If you have any questions or problems running things, please do get in touch!