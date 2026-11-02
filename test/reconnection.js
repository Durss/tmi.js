const WebSocket = require('ws');
const EventEmitter = require('../lib/EventEmitter');

const noop = () => {};
const wait = duration => new Promise(resolve => setTimeout(resolve, duration));

// Loads a copy of the client that uses the given socket class, as it's picked on load
function loadClient(socketClass) {
	const paths = [ '../index', '../lib/Client', '../lib/ClientBase' ].map(path => require.resolve(path));
	const cached = paths.map(path => require.cache[path]);
	const realWebSocket = global.WebSocket;
	paths.forEach(path => delete require.cache[path]);
	global.WebSocket = socketClass;
	const { Client } = require('../');
	global.WebSocket = realWebSocket;
	paths.forEach((path, index) => {
		if(cached[index]) {
			require.cache[path] = cached[index];
		}
		else {
			delete require.cache[path];
		}
	});
	return Client;
}

let sockets = [];

// Fake socket connected to a minimal Twitch server
class FakeSocket {
	constructor() {
		this.readyState = 0;
		this.closeDelay = 1;
		this.sent = [];
		sockets.push(this);
		setTimeout(() => {
			if(this.readyState === 0) {
				this.readyState = 1;
				this.onopen?.();
			}
		}, FakeSocket.openDelay);
	}
	send(line) {
		this.sent.push(line);
		if(line.startsWith('NICK')) {
			setTimeout(() => this.receive(':tmi.twitch.tv 376 me :>'), 1);
		}
		else if(line.startsWith('JOIN')) {
			const [ , channel ] = line.split(' ');
			setTimeout(() => {
				this.receive(`@display-name=me;mod=0;subscriber=0;user-type= :tmi.twitch.tv USERSTATE ${channel}`);
				this.receive(`@emote-only=0;room-id=1;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE ${channel}`);
			}, 1);
		}
	}
	receive(data) {
		if(this.readyState === 1) {
			this.onmessage?.({ data });
		}
	}
	close() {
		if(this.readyState < 2) {
			const wasConnecting = this.readyState === 0;
			this.readyState = 2;
			setTimeout(() => this.lose(wasConnecting), this.closeDelay);
		}
	}
	// Failed connections fire an error event before the close event
	lose(failed = false) {
		this.readyState = 3;
		if(failed) {
			this.onerror?.();
		}
		this.onclose?.({ code: 1006, reason: '', wasClean: false });
	}
}

describe('connection handling', () => {
	const Client = loadClient(FakeSocket);
	let client;

	const createClient = (channels = []) => {
		client = new Client({
			connection: { reconnectInterval: 20, reconnectDecay: 1, maxReconnectInterval: 20, timeout: 40 },
			identity: { username: 'me', password: 'oauth:fake' },
			channels
		});
		client.log.setLevel('fatal');
		return client;
	};
	const openSockets = () => sockets.filter(v => v.readyState === 1);

	// Twitch sends a message to every socket that's still open
	const countDispatches = () => {
		let count = 0;
		const listener = () => count++;
		client.on('raw_message', listener);
		openSockets().forEach(v => v.receive('@id=abc :tmi.twitch.tv USERNOTICE #me'));
		client.removeListener('raw_message', listener);
		return count;
	};

	beforeEach(() => {
		sockets = [];
		FakeSocket.openDelay = 1;
	});

	afterEach(() => {
		// Don't leave any timer running
		client.reconnect = false;
		client.disconnect().catch(noop);
	});

	describe('single socket', () => {
		it('opens one socket when connecting twice, both promises resolve', async () => {
			createClient();
			await Promise.all([ client.connect(), client.connect() ]);
			sockets.length.should.equal(1);
		});

		it('does nothing when connecting while connected', async () => {
			createClient();
			await client.connect();
			await client.connect();
			sockets.length.should.equal(1);
			countDispatches().should.equal(1);
		});

		it('recovers with one socket after a drop', async () => {
			createClient();
			await client.connect();
			sockets[0].lose();
			await wait(60);
			sockets.length.should.equal(2);
			countDispatches().should.equal(1);
		});

		it('keeps one socket when connecting while waiting to reconnect', async () => {
			createClient();
			await client.connect();
			sockets[0].lose();
			client.reconnecting.should.be.true();
			await client.connect();
			client.reconnecting.should.be.false();
			await wait(60);
			sockets.length.should.equal(2);
			countDispatches().should.equal(1);
		});

		it('keeps one socket when forcing a reconnection while waiting to reconnect', async () => {
			createClient();
			await client.connect();
			sockets[0].lose();
			await client.forceReconnect();
			const socket = client.ws;
			await wait(60);
			client.ws.should.be.exactly(socket);
			sockets.length.should.equal(2);
			countDispatches().should.equal(1);
		});

		it('keeps one socket when connecting after a RECONNECT from Twitch', async () => {
			createClient();
			await client.connect();
			sockets[0].receive(':tmi.twitch.tv RECONNECT');
			await wait(5);
			client.readyState().should.equal('CLOSED');
			await client.connect();
			await wait(60);
			sockets.length.should.equal(2);
			countDispatches().should.equal(1);
		});

		it('reconnects by itself after a RECONNECT from Twitch', async () => {
			createClient();
			await client.connect();
			sockets[0].receive(':tmi.twitch.tv RECONNECT');
			await wait(60);
			sockets.length.should.equal(2);
			client.readyState().should.equal('OPEN');
		});

		it('replaces a socket whose close event is slower than the reconnection', async () => {
			createClient([ 'me' ]);
			let joins = 0;
			client.on('join', (_channel, _username, self) => {
				if(self) {
					joins++;
				}
			});
			await client.connect();
			await wait(10);
			joins.should.equal(1);

			const [ first ] = sockets;
			first.closeDelay = 400;
			first.receive(':tmi.twitch.tv RECONNECT');
			await wait(200);

			// The new socket is up and the client knows it has to join channels again
			(first.onmessage === null).should.be.true();
			client.ws.should.be.exactly(sockets[1]);
			client.readyState().should.equal('OPEN');
			joins.should.equal(2);

			// The late close event of the previous socket changes nothing
			await wait(300);
			first.readyState.should.equal(3);
			client.ws.should.be.exactly(sockets[1]);
			client.readyState().should.equal('OPEN');
			sockets.length.should.equal(2);
		});

		it('keeps the next socket if a listener reconnects when a connection fails', async () => {
			createClient();
			await client.connect();
			client.once('disconnected', () => client.connect().catch(noop));
			sockets[0].lose(true);
			await wait(60);
			client.ws.should.be.exactly(sockets[1]);
			client.readyState().should.equal('OPEN');
			sockets.length.should.equal(2);
		});

		it('stays connected if a listener reconnects while a socket gets replaced', async () => {
			createClient();
			await client.connect();
			client.once('disconnected', () => client.connect().catch(noop));
			await client.forceReconnect();
			await wait(60);
			sockets.length.should.equal(2);
			countDispatches().should.equal(1);
		});
	});

	describe('disconnect', () => {
		it('doesn\'t reconnect when called while connecting', async () => {
			createClient();
			const connecting = client.connect();
			const error = connecting.then(noop, err => err);
			await client.disconnect();
			(await error).should.equal('Connection closed.');
			await wait(60);
			client.reconnecting.should.be.false();
			client.readyState().should.equal('CLOSED');
			sockets.length.should.equal(1);
		});

		it('cancels a scheduled reconnection', async () => {
			createClient();
			await client.connect();
			sockets[0].lose();
			await client.disconnect();
			await wait(60);
			client.readyState().should.equal('CLOSED');
			sockets.length.should.equal(1);
		});

		it('still fails if there\'s nothing to disconnect', async () => {
			createClient();
			const error = await client.disconnect().then(noop, err => err);
			error.should.match(/^Cannot disconnect/);
		});

		it('gives the reason of the current disconnection, not of a previous one', async () => {
			createClient();
			await client.connect();
			const reasons = [];
			client.on('disconnected', reason => reasons.push(reason));
			await client.forceReconnect();
			sockets[1].lose();
			reasons.should.eql([ 'Connection closed.', 'Connection lost.' ]);
		});

		it('emits disconnected once when a connection fails', async () => {
			createClient();
			await client.connect();
			let count = 0;
			client.on('disconnected', () => count++);
			sockets[0].lose(true);
			await wait(5);
			count.should.equal(1);
		});
	});

	describe('forceReconnect', () => {
		it('replaces a working connection right away', async () => {
			createClient();
			await client.connect();
			sockets[0].closeDelay = 200;
			await client.forceReconnect();
			sockets.length.should.equal(2);
			client.ws.should.be.exactly(sockets[1]);
			client.readyState().should.equal('OPEN');
		});

		it('resolves the connect() promise that was pending on the previous socket', async () => {
			FakeSocket.openDelay = 10;
			createClient();
			const connecting = client.connect();
			await Promise.all([ client.forceReconnect(), connecting ]);
			sockets.length.should.equal(2);
			client.readyState().should.equal('OPEN');
		});

		it('emits disconnected and resolves a pending disconnect()', async () => {
			createClient();
			await client.connect();
			sockets[0].closeDelay = 200;
			let count = 0;
			client.on('disconnected', () => count++);
			const disconnecting = client.disconnect();
			await client.forceReconnect();
			await disconnecting;
			count.should.equal(1);
		});

		it('leaves automatic reconnections working if the close event never came', async () => {
			createClient();
			await client.connect();
			sockets[0].closeDelay = 200;
			client.disconnect().catch(noop);
			await client.forceReconnect();
			sockets[1].lose();
			await wait(60);
			client.readyState().should.equal('OPEN');
			sockets.length.should.equal(3);
		});

		it('enables automatic reconnections back after an authentication failure', async () => {
			createClient();
			await client.connect();
			sockets[0].receive(':tmi.twitch.tv NOTICE * :Login authentication failed');
			await wait(60);
			client.readyState().should.equal('CLOSED');
			sockets.length.should.equal(1);

			await client.forceReconnect();
			sockets.length.should.equal(2);
			sockets[1].lose();
			await wait(60);
			client.readyState().should.equal('OPEN');
			sockets.length.should.equal(3);
		});
	});

	describe('ping', () => {
		it('only runs one timer when pinging twice', async () => {
			createClient();
			await client.connect();
			client.ping().catch(noop);
			await wait(10);
			client.ping().catch(noop);
			sockets[0].receive('PONG :tmi.twitch.tv');
			await wait(80);
			sockets[0].readyState.should.equal(1);
		});

		it('still closes the connection if no answer comes', async () => {
			createClient();
			await client.connect();
			client.ping().catch(noop);
			await wait(60);
			sockets[0].readyState.should.not.equal(1);
		});

		it('doesn\'t let the timer of a replaced socket close the next one', async () => {
			createClient();
			await client.connect();
			client.ping().catch(noop);
			await client.forceReconnect();
			await wait(80);
			sockets[1].readyState.should.equal(1);
		});

		it('stops the ping loop of a replaced socket', async () => {
			createClient();
			await client.connect();
			const loop = client.pingLoop;
			await client.forceReconnect();
			client.pingLoop.should.not.be.exactly(loop);
			loop._destroyed.should.be.true();
		});
	});

	describe('join', () => {
		it('joins a channel requested while connecting', async () => {
			FakeSocket.openDelay = 10;
			createClient();
			client.connect().catch(noop);
			const joined = await client.join('other');
			joined.should.eql([ '#other' ]);
			sockets[0].sent.should.containEql('JOIN #other');
		});

		it('joins a channel requested while waiting to reconnect', async () => {
			createClient();
			await client.connect();
			sockets[0].lose();
			const joined = await client.join('other');
			joined.should.eql([ '#other' ]);
			sockets[1].sent.should.containEql('JOIN #other');
		});

		it('joins a channel requested while the socket gets closed for a reconnection', async () => {
			createClient();
			await client.connect();
			sockets[0].closeDelay = 300;
			client.ping().catch(noop);
			await wait(100);
			client.readyState().should.equal('CLOSING');
			const joined = await client.join('other');
			joined.should.eql([ '#other' ]);
		});

		it('still fails if no connection is coming', async () => {
			createClient();
			const neverConnected = await client.join('other').then(noop, err => err);
			neverConnected.should.equal('Not connected to server.');

			await client.connect();
			await client.disconnect();
			const disconnected = await client.join('other').then(noop, err => err);
			disconnected.should.equal('Not connected to server.');
		});

		it('doesn\'t join a channel left before being connected', async () => {
			FakeSocket.openDelay = 10;
			createClient();
			const connecting = client.connect();
			client.join('other').catch(noop);
			client.part('other').catch(noop);
			await connecting;
			await wait(5);
			sockets[0].sent.should.not.containEql('JOIN #other');
		});
	});

	describe('socketclose', () => {
		it('gives the close event of the current socket', async () => {
			createClient();
			const events = [];
			client.on('socketclose', event => events.push(event));
			await client.connect();
			sockets[0].lose();
			events.map(v => v.code).should.eql([ 1006 ]);
		});

		it('is emitted once if the connection fails with an error', async () => {
			createClient();
			const events = [];
			client.on('socketclose', event => events.push(event));
			await client.connect();
			sockets[0].lose(true);
			events.length.should.equal(1);
		});

		it('gives the close event of a replaced socket', async () => {
			createClient();
			const events = [];
			client.on('socketclose', event => events.push(event));
			await client.connect();
			await client.forceReconnect();
			await wait(5);
			events.map(v => v.code).should.eql([ 1006 ]);
		});
	});
});

describe('EventEmitter', () => {
	it('calls all the listeners when one removes itself', () => {
		const emitter = new EventEmitter();
		const calls = [];
		emitter.once('test', () => calls.push('first'));
		emitter.once('test', () => calls.push('second'));
		emitter.on('test', () => calls.push('third'));
		emitter.emit('test');
		calls.should.eql([ 'first', 'second', 'third' ]);
		emitter.emit('test');
		calls.should.eql([ 'first', 'second', 'third', 'third' ]);
	});
});

const implementations = [ [ 'ws', WebSocket ] ];
if(global.WebSocket) {
	implementations.push([ 'native WebSocket', global.WebSocket ]);
}

implementations.forEach(([ name, socketClass ]) => {
	describe(`connection handling with real sockets (${name})`, () => {
		const Client = loadClient(socketClass);
		let client;
		let server;
		let connections;

		beforeEach(() => {
			connections = [];
			// Not the port of the other tests, some of them leave clients trying to reconnect
			server = new WebSocket.Server({ port: 7001 });
			server.on('connection', ws => {
				connections.push(ws);
				ws.on('message', message => {
					if(String(message).startsWith('NICK')) {
						ws.send(':tmi.twitch.tv 376 me :>');
					}
				});
			});
			client = new Client({
				connection: {
					server: 'localhost',
					port: 7001,
					reconnectInterval: 20,
					reconnectDecay: 1,
					maxReconnectInterval: 20
				}
			});
			client.log.setLevel('fatal');
		});

		afterEach(async () => {
			client.reconnect = false;
			client.disconnect().catch(noop);
			server.clients.forEach(ws => ws.terminate());
			await new Promise(resolve => server.close(resolve));
		});

		it('doesn\'t reconnect when disconnecting while connecting', async () => {
			client.connect().catch(noop);
			await client.disconnect();
			await wait(100);
			client.reconnecting.should.be.false();
			client.readyState().should.equal('CLOSED');
		});

		it('can force a reconnection while connecting', async () => {
			const connecting = client.connect();
			await Promise.all([ client.forceReconnect(), connecting ]);
			client.readyState().should.equal('OPEN');
		});

		it('can force a reconnection while connected', async () => {
			await client.connect();
			await client.forceReconnect();
			client.readyState().should.equal('OPEN');
			await wait(50);
			connections.filter(ws => ws.readyState === 1).length.should.equal(1);
		});

		it('reconnects once after a lost connection', async () => {
			await client.connect();
			let disconnections = 0;
			client.on('disconnected', () => disconnections++);
			connections[0].terminate();
			await wait(100);
			disconnections.should.equal(1);
			connections.length.should.equal(2);
			client.readyState().should.equal('OPEN');
		});
	});
});
