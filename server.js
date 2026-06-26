'use strict';

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const https = require('https');

// This script is spawned as a child process when the plugin's settings modal
// is opened, and terminated when it closes. It exposes request handlers that
// the front-end (public/index.html) calls via homebridge.request(...).
class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
	super();

	// Front-end calls homebridge.request('/stations', { apiKey, apiSecret }).
	this.onRequest('/stations', async (payload) => {
	  const { apiKey, apiSecret } = payload || {};
	  if (!apiKey || !apiSecret) {
		throw new Error('Enter your API Key and API Secret first.');
	  }
	  const data = await this.fetchStations(apiKey, apiSecret);
	  const stations = (data && data.stations) || [];
	  // Return a trimmed shape the UI can render directly.
	  return stations.map((s) => ({
		id: s.station_id,
		name: s.station_name || `Station ${s.station_id}`,
	  }));
	});

	// Signal to the UI that the server is ready to receive requests.
	this.ready();
  }

  fetchStations(apiKey, apiSecret) {
	return new Promise((resolve, reject) => {
	  const options = {
		hostname: 'api.weatherlink.com',
		path: `/v2/stations?api-key=${encodeURIComponent(apiKey)}`,
		method: 'GET',
		headers: { 'X-Api-Secret': apiSecret },
	  };
	  const req = https.request(options, (res) => {
		let body = '';
		res.on('data', (c) => (body += c));
		res.on('end', () => {
		  let json;
		  try {
			json = JSON.parse(body);
		  } catch (e) {
			return reject(new Error(`Unexpected response (HTTP ${res.statusCode}).`));
		  }
		  if (res.statusCode !== 200) {
			// The v2 API returns { message: "..." } on errors (e.g. bad key).
			return reject(new Error(json.message || `Request failed (HTTP ${res.statusCode}).`));
		  }
		  resolve(json);
		});
	  });
	  req.on('error', reject);
	  req.end();
	});
  }
}

// Instantiate. (IIFE keeps the linter happy about an "unused" instance.)
(() => new PluginUiServer())();