'use strict';

var libQ = require('kew');
var libNet = require('net');
var libFast = require('fast.js');
var libLevel = require('level');
var fs=require('fs-extra');
var exec = require('child_process').exec;

// Define the ControllerSpop class
module.exports = ControllerSpop;
function ControllerSpop(context) {
	// This fixed variable will let us refer to 'this' object at deeper scopes
	var self = this;

	self.context=context;
	self.commandRouter = self.context.coreCommand;
}


ControllerSpop.prototype.getConfigurationFiles = function()
{
	var self = this;

	return ['config.json'];
}

// Plugin methods -----------------------------------------------------------------------------
ControllerSpop.prototype.onVolumioStart = function() {
	var self = this;

	//var configFile=self.commandRouter.pluginManager.getConfigurationFile(self.context,'config.json');
	//config.loadFile(configFile);

	// TODO use names from the package.json instead
	self.servicename = 'spop';
	self.displayname = 'Spotify';


	// Each core gets its own set of Spop sockets connected
	var nHost='localhost';
	var nPort=6602;
	self.connSpopCommand = libNet.createConnection(nPort, nHost); // Socket to send commands and receive track listings
	self.connSpopStatus = libNet.createConnection(nPort, nHost); // Socket to listen for status changes

	// Start a listener for receiving errors
	self.connSpopCommand.on('error', function(err) {
		console.error('SPOP command error:');
		console.error(err);
	});
	self.connSpopStatus.on('error', function(err) {
		console.error('SPOP status error:');
		console.error(err);
	});

	// Init some command socket variables
	self.bSpopCommandGotFirstMessage = false;
	self.spopCommandReadyDeferred = libQ.defer(); // Make a promise for when the Spop connection is ready to receive events (basically when it emits 'spop 0.0.1').
	self.spopCommandReady = self.spopCommandReadyDeferred.promise;
	self.arrayResponseStack = [];
	self.sResponseBuffer = '';

	// Start a listener for command socket messages (command responses)
	self.connSpopCommand.on('data', function(data) {
		self.sResponseBuffer = self.sResponseBuffer.concat(data.toString());

		// If the last character in the data chunk is a newline, this is the end of the response
		if (data.slice(data.length - 1).toString() === '\n') {
			// If this is the first message, then the connection is open
			if (!self.bSpopCommandGotFirstMessage) {
				self.bSpopCommandGotFirstMessage = true;
				try {
					self.spopCommandReadyDeferred.resolve();
				} catch (error) {
					self.pushError(error);
				}
				// Else this is a command response
			} else {
				try {
					self.arrayResponseStack.shift().resolve(self.sResponseBuffer);
				} catch (error) {
					self.pushError(error);
				}
			}

			// Reset the response buffer
			self.sResponseBuffer = '';
		}
	});

	// Init some status socket variables
	self.bSpopStatusGotFirstMessage = false;
	self.sStatusBuffer = '';

	// Start a listener for status socket messages
	self.connSpopStatus.on('data', function(data) {
		self.sStatusBuffer = self.sStatusBuffer.concat(data.toString());

		// If the last character in the data chunk is a newline, this is the end of the status update
		if (data.slice(data.length - 1).toString() === '\n') {
			// Put socket back into monitoring mode
			self.connSpopStatus.write('idle\n');

			// If this is the first message, then the connection is open
			if (!self.bSpopStatusGotFirstMessage) {
				self.bSpopStatusGotFirstMessage = true;
				// Else this is a state update announcement
			} else {
				var timeStart = Date.now();
				var sStatus = self.sStatusBuffer;

				self.logStart('Spop announces state update')
					.then(function() {
						return self.parseState.call(self, sStatus);
					})
					.then(libFast.bind(self.pushState, self))
					.fail(libFast.bind(self.pushError, self))
					.done(function() {
						return self.logDone(timeStart);
					});
			}

			// Reset the status buffer
			self.sStatusBuffer = '';
		}
	});

	// Define the tracklist
	self.tracklist = [];

	// Start tracklist promise as rejected, so requestors do not wait for it if not immediately available.
	// This is okay because no part of Volumio requires a populated tracklist to function.
	self.tracklistReadyDeferred = null;
	self.tracklistReady = libQ.reject('Tracklist not yet populated.');

	// Attempt to load tracklist from database on disk
	// TODO make this a relative path
	self.sTracklistPath = __dirname + '/db/tracklist';
	self.loadTracklistFromDB()
		.fail(libFast.bind(self.pushError, self));



	exec("spopd -c /etc/spopd.conf", function (error, stdout, stderr) {
		if (error !== null) {
			self.commandRouter.pushConsoleMessage('The following error occurred while starting SPOPD: ' + error);
		}
		else {
			self.commandRouter.pushConsoleMessage('SpopD Daemon Started');
		}
	});
};

ControllerSpop.prototype.onStop = function() {
	var self = this;
	exec("killall spopd", function (error, stdout, stderr) {

	});
};

ControllerSpop.prototype.onRestart = function() {
	var self = this;
	//
};

ControllerSpop.prototype.onInstall = function() {
	var self = this;
	//Perform your installation tasks here
};

ControllerSpop.prototype.onUninstall = function() {
	var self = this;
	//Perform your installation tasks here
};

ControllerSpop.prototype.getUIConfig = function() {
	var self = this;

	return {success:true,plugin:"spop"};
};

ControllerSpop.prototype.setUIConfig = function(data) {
	var self = this;
	//Perform your installation tasks here
};

ControllerSpop.prototype.getConf = function(varName) {
	var self = this;
	//Perform your installation tasks here
};

ControllerSpop.prototype.setConf = function(varName, varValue) {
	var self = this;
	//Perform your installation tasks here
};

// Public Methods ---------------------------------------------------------------------------------------
// These are 'this' aware, and return a promise

// Load the tracklist from database on disk
ControllerSpop.prototype.loadTracklistFromDB = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::loadTracklistFromDB');
	self.commandRouter.pushConsoleMessage('Loading Spop tracklist from DB...');

	self.tracklist = [];

	self.tracklistReadyDeferred = libQ.defer();
	self.tracklistReady = self.tracklistReadyDeferred.promise;

	var dbTracklist = libLevel(self.sTracklistPath, {'valueEncoding': 'json', 'createIfMissing': true});

	return libQ.resolve()
	.then(function() {
		return libQ.nfcall(libFast.bind(dbTracklist.get, dbTracklist), 'tracklist');
	})
	.then(function(result) {
		self.tracklist = result;

		self.commandRouter.pushConsoleMessage('Spop tracklist loaded from DB.');

		try {
			self.tracklistReadyDeferred.resolve();
		} catch (error) {
			self.pushError('Unable to resolve tracklist promise: ' + error);
		}

		return libQ.resolve();
	})
	.fail(function(sError) {
		try {
			self.tracklistReadyDeferred.reject(sError);
		} catch (error) {
			self.pushError('Unable to reject tracklist promise: ' + error);
		}

		throw new Error('Error reading DB: ' + sError);
	})
	.fin(libFast.bind(dbTracklist.close, dbTracklist));
};

// Rebuild a library of user's playlisted Spotify tracks
ControllerSpop.prototype.rebuildTracklist = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::rebuildTracklist');

	self.tracklist = [];
	self.tracklistReadyDeferred = libQ.defer();
	self.tracklistReady = self.tracklistReadyDeferred.promise;

	var dbTracklist = libLevel(self.sTracklistPath, {'valueEncoding': 'json', 'createIfMissing': true});

	self.commandRouter.pushConsoleMessage('Populating Spop tracklist...');

	// Scan the user's Spotify playlists and populate the tracklist
	return self.sendSpopCommand('ls', [])
	.then(JSON.parse)
	.then(function(objPlaylists) {
		return self.rebuildTracklistFromSpopPlaylists(objPlaylists, [self.displayname]);
	})
	.then(function() {
		self.commandRouter.pushConsoleMessage('Storing Spop tracklist in db...');

		var ops = [
			{type: 'put', key: 'tracklist', value: self.tracklist}
		];

		return libQ.nfcall(libFast.bind(dbTracklist.batch, dbTracklist), ops);
	})
	.then(function() {
		self.commandRouter.pushConsoleMessage('Spop tracklist rebuild complete.');

		try {
			self.tracklistReadyDeferred.resolve();
		} catch (error) {
			self.pushError('Unable to resolve tracklist promise: ' + error);
		}

		return libQ.resolve();
	})
	.fail(function(sError) {
		try {
			self.tracklistReadyDeferred.reject(sError);
		} catch (error) {
			self.pushError('Unable to reject tracklist promise: ' + error);
		}

		throw new Error('Tracklist Rebuild Error: ' + sError);
	})
	.fin(libFast.bind(dbTracklist.close, dbTracklist));
};

// Define a method to clear, add, and play an array of tracks
ControllerSpop.prototype.clearAddPlayTracks = function(arrayTrackUris) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::clearAddPlayTracks');

	// Clear the queue, add the first track, and start playback
	var firstTrack = arrayTrackUris.shift();
	var promisedActions = self.sendSpopCommand('uplay', [firstTrack]);

	// If there are more tracks in the array, add those also
	if (arrayTrackUris.length > 0) {
		promisedActions = libFast.reduce(arrayTrackUris, function(previousPromise, curTrackUri) {
			return previousPromise
			.then(function() {
				return self.sendSpopCommand('uadd', [curTrackUri]);
			});
		}, promisedActions);
	}
	return promisedActions;
};

// Spop stop
ControllerSpop.prototype.stop = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::stop');

	return self.sendSpopCommand('stop', []);
};

// Spop pause
ControllerSpop.prototype.pause = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::pause');

	// TODO don't send 'toggle' if already paused
	return self.sendSpopCommand('toggle', []);
};

// Spop resume
ControllerSpop.prototype.resume = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::resume');

	// TODO don't send 'toggle' if already playing
	return self.sendSpopCommand('toggle', []);
};

// Spop music library
ControllerSpop.prototype.getTracklist = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::getTracklist');

	return self.tracklistReady
	.then(function() {
		return self.tracklist;
	});
};

// Internal methods ---------------------------------------------------------------------------
// These are 'this' aware, and may or may not return a promise

// Send command to Spop
ControllerSpop.prototype.sendSpopCommand = function(sCommand, arrayParameters) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::sendSpopCommand');

	// Convert the array of parameters to a string
	var sParameters = libFast.reduce(arrayParameters, function(sCollected, sCurrent) {
		return sCollected + ' ' + sCurrent;
	}, '');

	// Pass the command to Spop when the command socket is ready
	self.spopCommandReady
	.then(function() {
		return libQ.nfcall(libFast.bind(self.connSpopCommand.write, self.connSpopCommand), sCommand + sParameters + '\n', 'utf-8');
	});

	var spopResponseDeferred = libQ.defer();
	var spopResponse = spopResponseDeferred.promise;
	self.arrayResponseStack.push(spopResponseDeferred);

	// Return a promise for the command response
	return spopResponse;
};

// Spop get state
ControllerSpop.prototype.getState = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::getState');

	return self.sendSpopCommand('status', []);
};

// Spop parse state
ControllerSpop.prototype.parseState = function(sState) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::parseState');

	var objState = JSON.parse(sState);

	var nSeek = null;
	if ('position' in objState) {
		nSeek = objState.position * 1000;
	}

	var nDuration = null;
	if ('duration' in objState) {
		nDuration = objState.duration;
	}

	var sStatus = null;
	if ('status' in objState) {
		if (objState.status === 'playing') {
			sStatus = 'play';
		} else if (objState.status === 'paused') {
			sStatus = 'pause';
		} else if (objState.status === 'stopped') {
			sStatus = 'stop';
		}
	}

	var nPosition = null;
	if ('current_track' in objState) {
		nPosition = objState.current_track - 1;
	}

	return libQ.resolve({
		status: sStatus,
		position: nPosition,
		seek: nSeek,
		duration: nDuration,
		samplerate: null, // Pull these values from somwhere else since they are not provided in the Spop state
		bitdepth: null,
		channels: null
	});
};

// Announce updated Spop state
ControllerSpop.prototype.pushState = function(state) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::pushState');

	return self.commandRouter.servicePushState(state, self.servicename);
};

// Pass the error if we don't want to handle it
ControllerSpop.prototype.pushError = function(sReason) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::pushError(' + sReason + ')');

	// Return a resolved empty promise to represent completion
	return libQ.resolve();
};

// Scan tracks in playlists via Spop and populates tracklist
// Metadata fields to roughly conform to Ogg Vorbis standards (http://xiph.org/vorbis/doc/v-comment.html)
ControllerSpop.prototype.rebuildTracklistFromSpopPlaylists = function(objInput, arrayPath) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'ControllerSpop::rebuildTracklistFromSpopPlaylists');

	if (!('playlists' in objInput)) {
		throw new Error('Error building Spop tracklist - no playlists found.');
	}

	var arrayPlaylists = objInput.playlists;
	// We want each playlist to be parsed sequentially instead of simultaneously so that Spop is not overwhelmed
	// with requests. Use this chained promisedActions to guarantee sequential execution.
	var promisedActions = libQ.resolve();

	libFast.map(arrayPlaylists, function(curPlaylist) {
/*
		if (!('index' in curPlaylist)) {
			return;
		}*/
		var sPlaylistName = '';
		if (curPlaylist.name === '') {
			// The Starred playlist has a blank name
			sPlaylistName = 'Starred';
		} else {
			sPlaylistName = curPlaylist.name;
		}
		var arrayNewPath = arrayPath.concat(sPlaylistName);

		if (curPlaylist.type === 'folder') {
			promisedActions = promisedActions
				.then(function() {
					return self.rebuildTracklistFromSpopPlaylists(curPlaylist, arrayNewPath);
				});

		} else if (curPlaylist.type === 'playlist') {
			var curPlaylistIndex = curPlaylist.index;

			promisedActions = promisedActions
			.then(function() {
				return self.sendSpopCommand('ls', [curPlaylistIndex]);
			})
			.then(JSON.parse)
			.then(function(curTracklist) {
				var nTracks = 0;

				if (!('tracks' in curTracklist)) {
					return;
				}

				nTracks = curTracklist.tracks.length;

				for (var j = 0; j < nTracks; j++) {
					self.tracklist.push({
						'name': curTracklist.tracks[j].title,
						'service': self.servicename,
						'uri': curTracklist.tracks[j].uri,
						'browsepath': arrayNewPath,
						'album': curTracklist.tracks[j].album,
						'artists': libFast.map(curTracklist.tracks[j].artist.split(','), function(sArtist) {
							// TODO - parse other options in artist string, such as "feat."
							return sArtist.trim();

						}),
						'performers': [],
						'genres': [],
						'tracknumber': 0,
						'date': '',
						'duration': 0
					});
				}
			});
		}
	});

	return promisedActions;
};

ControllerSpop.prototype.logDone = function(timeStart) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + '------------------------------ ' + (Date.now() - timeStart) + 'ms');
	return libQ.resolve();
};

ControllerSpop.prototype.logStart = function(sCommand) {
	var self = this;
	self.commandRouter.pushConsoleMessage('\n' + '[' + Date.now() + '] ' + '---------------------------- ' + sCommand);
	return libQ.resolve();
};