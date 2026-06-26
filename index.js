// homebridge-weatherlink-cloud  —  starter skeleton
//
// A Homebridge dynamic platform plugin that polls the WeatherLink v2 cloud
// API and exposes your Vantage Vue readings to HomeKit.
//
// Pairs with a minimal package.json (see notes at bottom of this file).
//
// config.json example:
// {
//   "platforms": [
//     {
//       "platform": "WeatherLinkCloud",
//       "name": "WeatherLink",
//       "apiKey": "YOUR_V2_API_KEY",
//       "apiSecret": "YOUR_V2_API_SECRET",
//       "stationId": 123456,
//       "pollMinutes": 15
//     }
//   ]
// }

'use strict';

const https = require('https');

const PLUGIN_NAME = 'homebridge-weatherlink-cloud';
const PLATFORM_NAME = 'WeatherLinkCloud';

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerPlatform(PLATFORM_NAME, WeatherLinkCloudPlatform);
};

class WeatherLinkCloudPlatform {
  constructor(log, config, api) {
	this.log = log;
	this.api = api;

	this.apiKey = config.apiKey;
	this.apiSecret = config.apiSecret;
	this.stationId = config.stationId;
	// Match this to your weatherlink.com tier: ~15 (free) or ~5 (Pro).
	// Polling faster than the data refreshes just wastes API calls.
	this.pollSeconds = (config.pollMinutes || 15) * 60;

	this.accessories = new Map(); // UUID -> cached accessory

	this.api.on('didFinishLaunching', () => {
	  this.setupAccessories();
	  this.poll();
	  setInterval(() => this.poll(), this.pollSeconds * 1000);
	});
  }

  // Homebridge calls this once per cached accessory at startup.
  configureAccessory(accessory) {
	this.accessories.set(accessory.UUID, accessory);
  }

  getOrCreate(idSuffix, name, serviceType) {
	const uuid = this.api.hap.uuid.generate(
	  `${PLATFORM_NAME}:${this.stationId}:${idSuffix}`
	);
	let accessory = this.accessories.get(uuid);
	if (!accessory) {
	  accessory = new this.api.platformAccessory(name, uuid);
	  accessory.addService(serviceType, name);
	  this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
	  this.accessories.set(uuid, accessory);
	  this.log(`Created accessory: ${name}`);
	}
	return accessory;
  }

  setupAccessories() {
	// Native HomeKit service types — these display cleanly in Apple's Home app.
	this.tempAcc = this.getOrCreate('outTemp', 'Outdoor Temperature', Service.TemperatureSensor);
	this.humAcc  = this.getOrCreate('outHum',  'Outdoor Humidity',    Service.HumiditySensor);

	// Wind / rain / pressure / UV have NO native HomeKit service.
	// Options to surface them:
	//   - Eve custom characteristics (shown in the Eve app, ignored by Home app)
	//   - A LightSensor service repurposed to carry a raw number (a hack)
	// Add those here once you've decided which approach you want.
  }

  poll() {
	this.fetchCurrent()
	  .then((data) => this.applyData(data))
	  .catch((err) => this.log.error('Poll failed:', err.message));
  }

  fetchCurrent() {
	// v2 API: api-key as a query param, secret in the X-Api-Secret header.
	// (v2 also supports an older HMAC api-signature scheme — the header
	//  method below is the simpler one. Confirm against the official docs:
	//  https://weatherlink.github.io/v2-api/ )
	return new Promise((resolve, reject) => {
	  const options = {
		hostname: 'api.weatherlink.com',
		path: `/v2/current/${this.stationId}?api-key=${this.apiKey}`,
		method: 'GET',
		headers: { 'X-Api-Secret': this.apiSecret },
	  };
	  const req = https.request(options, (res) => {
		let body = '';
		res.on('data', (c) => (body += c));
		res.on('end', () => {
		  try {
			resolve(JSON.parse(body));
		  } catch (e) {
			reject(new Error(`Bad JSON (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
		  }
		});
	  });
	  req.on('error', reject);
	  req.end();
	});
  }

  applyData(data) {
	// The /current payload nests readings under sensors[].data[]. Each sensor
	// block has a sensor_type and data_structure_type; you need to locate the
	// ISS block for your Vantage Vue. The reliable way to learn the exact shape:
	// log the whole payload ONCE, eyeball it, then pull the fields you need.
	//
	//   this.log(JSON.stringify(data, null, 2));   // <- run this once, then delete
	//
	// Field names below (temp, hum) are typical for a Vue ISS but VERIFY them
	// against your own dump — they live in °F and %.

	const sensors = (data && data.sensors) || [];
	let tempF, hum;

	for (const s of sensors) {
	  const d = (s.data && s.data[0]) || {};
	  if (typeof d.temp === 'number') tempF = d.temp;
	  if (typeof d.hum === 'number') hum = d.hum;
	  // Other fields you'll likely find here once you dump the payload:
	  //   d.wind_speed_last, d.wind_dir_last, d.rainfall_daily,
	  //   d.bar_sea_level, d.uv_index, d.solar_rad ...
	}

	if (typeof tempF === 'number') {
	  const tempC = ((tempF - 32) * 5) / 9;
	  this.tempAcc
		.getService(Service.TemperatureSensor)
		.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
	}
	if (typeof hum === 'number') {
	  this.humAcc
		.getService(Service.HumiditySensor)
		.updateCharacteristic(Characteristic.CurrentRelativeHumidity, hum);
	}
  }
}

// --- Minimal package.json to sit beside this file -------------------------
// {
//   "name": "homebridge-weatherlink-cloud",
//   "version": "0.1.0",
//   "main": "index.js",
//   "engines": { "homebridge": ">=1.6.0", "node": ">=18" },
//   "keywords": ["homebridge-plugin"]
// }
//
// Dev loop:
//   1. mkdir homebridge-weatherlink-cloud && cd it; add index.js + package.json
//   2. npm install -g . (or `npm link`) into your Homebridge install
//   3. add the platform block to Homebridge config.json
//   4. restart Homebridge, watch the logs, dump the payload, map fields
// --------------------------------------------------------------------------