
# Paxos - CSEP590 Project 1

This is an implementation of Paxos by Itay Neeman (itay) for CSEP590.

## Requirements and Installation

This implementation is written in JavaScript and Node.js. They should work
on all OSes, but it's mostly been tested on Mac OS X (though Linux shouldn't
be a problem). You can follow these simple steps to install:

1. Install Node.js (http://nodejs.org/#download). I recommend version 0.6.12 or
higher.

2. Put the Paxos files in some folder (say, 'paxos').

3. In that folder, type: `npm install`. This will install the few dependencies
the project has, such as a simple webserver, a WebSocket implementation, etc.

4. To run the project, simply run: `node app.js` and navigate your browser to
http://localhost:3000

## File Structure

The project has 3 main files:

1. `config.json`: a simple configuration file describing how many peers to start
up and what port to start them at.

2. `app.js`: the bootstrapper - this will start up all the peers, make the
WebSocket connection to the browser, etc.

3. `server.js`: the peer implementation - this is where Paxos is implemented.

## Architecture

### Terminology

Just to be clear, here is the terminology as it is used in the project.

#### Instance

Instance `k` is equivalent to the `k`th update to the storage. So if a client
tries to fetch the `k`th update for a particular name, they will be trying to
fetch the value that was chosen for the `k`th instance.

#### Peer

This is essentially a single Paxos node, usually represented by its port number.

#### Proposal

A proposal is a tuple of `number` and `port`. This was essentially done in order
to avoid the need to do bit shifting. Here is the `greaterThan` implementation:

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
    
#### Value

A single value to store for a particular name. Can by any arbitrary string.

#### Name

A particular name to work with.

### Endpoints

My version of Paxos has each peer acting as as an HTTP server, with essentially
five endpoints:

#### `/store`

This endpoint is invoked by the client with arguments `name` and `value`. The
Paxos peer will then start a Paxos round to determine an update number for this
name/value pair, and if it obtains one, the value will be stored.

#### `/fetch`

This endpoint is invoked by the client when it wants to fetch the `k`th update
for a particular name. It takes arguments `name` and `instance`, and will return
the value or not found if a value wasn't found.

#### `/propose`

This is the Paxos stage initiated by a proposer. For a given name/instance pair,
a proposer will send a propose message with a proposal (i.e. number/port) to
all acceptors.

When a peer receives a message on this endpoint, it will execute the logic in 
`handlePropose`, which will look to see if it has already accepted a value
and/or if it hasn't made a promise to not accept proposals lower than the
proposal we sent. It will send a response which indicates whether it accepts
the promise, and whether or not it has accepted a previous value (including
the proposal).

If a particular proposal is accepted but a value is already specified, we will
start a new Paxos **instance** for the original value, and continue the current
instance with the new value.

If a particular proposal is rejected, then we will try again with a higher
higher proposal, and on the same instance.

#### `/accept`

This is the Paxos stage intiated by a proposer is a quorum of acceptors agreed
to its proposal. For a given name/instance/value triple, a proposer will send an
accept message with the a proposal and a value to all acceptors. The value it
sends may not be the same value as it invoked `/propose` with, as some acceptors
may have already accepted a value and it will use those.

When a peer receives a message on this endpoint, it will execute the logic in 
`handleAccept`, which will basically ensure that that we can still accept this
proposal/value, in case we promised a higher proposal. It will respond either
with an accept or a rejection. Upon accepting, it will broadcast to all the
learners this fact.

If the proposer receives acceptances from a quorum of acceptors, it will respond
to the client saying their operation was successful.

If a proposer receives rejections from a quorum of acceptors, it will reset the
current instance and move back to the proposal stage, just incrementing the
proposal number.

#### `/learn`

This is a Paxos stage initiated by an acceptor upon accepting a value. The 
learner keeps track of any values it receives for a particular name/instance
pair, and once a particular value goes above the quorum threshold,
it will mark that value as fully learnt and ignore any new values for that
instance.

Note that we make a distinction between tentatively learnt (i.e. a quorum of
acceptors has not yet notified us that they have accepted a particular value
for a particular instance) and fully learnt (i.e. a quorum of acceptors has
notified us that they've accepted a particular value for a particular 
instance).

### Storage

Rather than store things in files, I chose to simply store them in memory,
essentially in hash maps keyed by name, then by instance. It makes it easier
to manage things rather than files.

However, these maps are "permanent" in the sense that they will serve our
simulated node "death".

### Message Passing

As noted above, all communication is done over HTTP (and thus TCP), which is 
reliable. To simulate lossy connections, messages can be dropped at any of 
the following points:

1. On receipt at one of the endpoints (e.g. when it comes into `/accept`).
2. When a peer replies to a message (e.g. an acceptor sending a promise to a 
`/propose` message).
3. When a peer receives an above reply.

This means that even with a relatively low probability, a single roundtrip
communication could be sabotaged at any of the 3 points, which leads to a 
much higher instance of drops.

Each message is sent with a 2 second timeout, so if a peer does not respond
within that time frame, it is assumed to be down.

### Peers Going Down

I simulated peers going down simply as having a drop probability of 1, so they
will drop any and all messages. They are essentially offline to other peers.
They can be revived by setting the drop probability to a value less than 1.

### Single Threadedness

Node.js is single threaded, so all the HTTP servers are essentially separate
message loops on a single thread. However, we still have non-determinism because
messages go through the OSes network layer, which will deliver messages to
different ports at different times.

### Fetching

If a peer has fully learnt a value for a particular instance, then that value
is guaranteed to be correct. As such, if a `/fetch` comes in to that peer, it
will simply return the value. We only initiate a Paxos round for `/fetch` if we
do not have a value for a particular instance.

When a peer needs to initiate a full Paxos round for learning, it will attempt
to propose a dummy value for that instance. If that proposal is promised by
a quorum of acceptors, then we know that no value exists for that instance,
and we notify the client. If any client returns a value for that particular
instance (because it had previously accepted it), then we simply continue
the Paxos round, and we register a listener to be notified when we've
fully learnt a value for that instance. We will wait for a 2 second timeout
before we declare that we failed to fetch a value.

## UI

There is a simple UI to interact with the Paxos cluster. It can be accessed
by navigating your tab to http://localhost:3000 (assuming that is the start
port configured in `config.json`).

The main pane shows the logs for all the peers combined together. Since the
peers are running on a single thread, the log is completely causal and is
very useful for debugging.

The pane for each peer allows you to:

* Kill and Revive a peer.
* Set a peer's drop probability (defaulted to 0).
* Store a value for a particular name.
* Fetch the value for a particular name and instance.
* View the log for just that peer.

You can clear the logs by simply refreshing the page. Note that if you restart
the server, you need to also refresh the page.

## Assumptions

One major assumption I made was that message duplication does not occur, even
though messages might be delayed/reordered/dropped. 

## Quirks/Known issues

I don't know of any issues, but I suspect at least two may exist, even though
I have not been able to ferret them out with tests:

1. A particular value might be marked as fully learnt even though it is the
same acceptor repeating the same message (because it keeps being proposed). This
could be solved by storing tentatively learnt values on a key of the 
value + proposal, so duplicates could not occur.

2. A gap might occur in the storage. This might happen if some instances think
we've incremented the instance number even though we haven't. I can't think of
a concrete way of this happening, but even if it does happening, a simple
compaction step could just compact instances with no values.

## Implementation Benefits

The fact that the three roles of proposer/acceptor/learner are implemented as 
a single event loop on a single thread makes it very easy to reason about the
program, as you do not need to worry about any locking or synchronization
semantics, nor do you need to manage threads.

It would be very easy to split each peer to run in its own process, such that
there would be a single thread per peer, but this doesn't add much and makes 
debugging harder.