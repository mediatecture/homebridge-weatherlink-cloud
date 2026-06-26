'use strict';

const https = require('https');

const PLUGIN_NAME = 'homebridge-weatherlink-cloud';
const PLATFORM_NAME = 'WeatherLinkCloud';
const PLUGIN_VERSION = require('./package.json').version;

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

	// Shown in the Home app's accessory details (Manufacturer / Model).
	this.manufacturer = config.manufacturer || 'Davis Instruments';
	this.model = config.model || 'Vantage Vue';

	this.accessories = new Map(); // UUID -> cached accessory

	this.api.on('didFinishLaunching', async () => {
	  try {
		await this.resolveStationId();
	  } catch (err) {
		this.log.error('Cannot start: ' + err.message);
		return; // No station ID -> don't create accessories or poll.
	  }
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

	// Set the AccessoryInformation service every time (not just on creation) so
	// that already-cached accessories showing "Default" get corrected on restart.
	// The serial must be UNIQUE per accessory, or HomeKit may merge or misbehave.
	accessory
	  .getService(Service.AccessoryInformation)
	  .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
	  .setCharacteristic(Characteristic.Model, this.model)
	  .setCharacteristic(Characteristic.SerialNumber, `${this.stationId}-${idSuffix}`)
	  .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

	return accessory;
  }

  setupAccessories() {
	// Native HomeKit service types — these display cleanly in Apple's Home app.
	this.tempAcc = this.getOrCreate('outTemp', 'Outdoor Temperature', Service.TemperatureSensor);
	this.humAcc  = this.getOrCreate('outHum',  'Outdoor Humidity',    Service.HumiditySensor);

	// Indoor readings come from the console's own barometer/inside sensor block.
	this.tempInAcc = this.getOrCreate('inTemp', 'Indoor Temperature', Service.TemperatureSensor);
	this.humInAcc  = this.getOrCreate('inHum',  'Indoor Humidity',    Service.HumiditySensor);

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
	return this.apiGet(`/v2/current/${this.stationId}`);
  }

  fetchStations() {
	return this.apiGet('/v2/stations');
  }

  apiGet(basePath) {
	// v2 API: api-key as a query param, secret in the X-Api-Secret header.
	// (v2 also supports an older HMAC api-signature scheme — the header
	//  method below is the simpler one. Confirm against the official docs:
	//  https://weatherlink.github.io/v2-api/ )
	return new Promise((resolve, reject) => {
	  const options = {
		hostname: 'api.weatherlink.com',
		path: `${basePath}?api-key=${this.apiKey}`,
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

  // Resolve this.stationId: use the configured value if present, otherwise
  // discover it from /v2/stations. Throws if it can't be determined.
  async resolveStationId() {
	if (this.stationId) {
	  this.log(`Using configured station ID ${this.stationId}.`);
	  return;
	}

	this.log('No station ID configured — fetching from /v2/stations ...');
	const data = await this.fetchStations();
	const stations = (data && data.stations) || [];

	if (stations.length === 0) {
	  throw new Error('No stations found on this WeatherLink account (check your API key/secret).');
	}

	if (stations.length === 1) {
	  this.stationId = stations[0].station_id;
	  this.log(`Discovered station "${stations[0].station_name}" (ID ${this.stationId}).`);
	  return;
	}

	// More than one station: we can't guess which you want, so list them all
	// and default to the first, telling you how to pin a specific one.
	this.log.warn('Multiple stations found on this account:');
	for (const s of stations) {
	  this.log.warn(`  - "${s.station_name}" -> stationId ${s.station_id}`);
	}
	this.stationId = stations[0].station_id;
	this.log.warn(
	  `Defaulting to "${stations[0].station_name}" (ID ${this.stationId}). ` +
	  'Set "stationId" in the plugin config to pin a specific station.'
	);
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
	let tempF, hum, tempInF, humIn;

	for (const s of sensors) {
	  const d = (s.data && s.data[0]) || {};
	  if (typeof d.temp === 'number') tempF = d.temp;          // outdoor temp, °F
	  if (typeof d.hum === 'number') hum = d.hum;              // outdoor RH, %
	  if (typeof d.temp_in === 'number') tempInF = d.temp_in;  // indoor temp, °F
	  if (typeof d.hum_in === 'number') humIn = d.hum_in;      // indoor RH, %
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
	if (typeof tempInF === 'number') {
	  const tempInC = ((tempInF - 32) * 5) / 9;
	  this.tempInAcc
		.getService(Service.TemperatureSensor)
		.updateCharacteristic(Characteristic.CurrentTemperature, tempInC);
	}
	if (typeof humIn === 'number') {
	  this.humInAcc
		.getService(Service.HumiditySensor)
		.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humIn);
	}
  }
}