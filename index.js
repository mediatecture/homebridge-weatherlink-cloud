'use strict';

const https = require('https');

const PLUGIN_NAME = 'homebridge-weatherlink-cloud';
const PLATFORM_NAME = 'WeatherLinkCloud';
const PLUGIN_VERSION = require('./package.json').version;

// One row per exposable sensor. `kind` picks the HomeKit service + unit handling
// ('temp' = TemperatureSensor with °F->°C, 'humidity' = HumiditySensor with %).
// `field` is the key in the v2 /current payload. `flag` is the config option that
// enables/disables it (all default ON). Add wind/rain/etc. here in future.
const SENSORS = [
  { key: 'outTemp',   name: 'Outdoor Temperature', kind: 'temp',     field: 'temp',      flag: 'enableOutdoorTemp' },
  { key: 'outHum',    name: 'Outdoor Humidity',    kind: 'humidity', field: 'hum',       flag: 'enableOutdoorHumidity' },
  { key: 'inTemp',    name: 'Indoor Temperature',  kind: 'temp',     field: 'temp_in',   flag: 'enableIndoorTemp' },
  { key: 'inHum',     name: 'Indoor Humidity',     kind: 'humidity', field: 'hum_in',    flag: 'enableIndoorHumidity' },
  { key: 'feelsLike', name: 'Feels Like (THW)',    kind: 'temp',     field: 'thw_index', flag: 'enableFeelsLike' },
];

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

	// Which sensors are enabled. Each defaults to ON unless explicitly false.
	this.enabled = {};
	for (const s of SENSORS) {
	  this.enabled[s.flag] = config[s.flag] !== false;
	}

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
	// Build the set of sensors the user has enabled, create each, and remember
	// which accessories should exist this run.
	this.activeSensors = SENSORS.filter((s) => this.enabled[s.flag]);
	const desiredUuids = new Set();

	for (const sensor of this.activeSensors) {
	  const serviceType =
		sensor.kind === 'temp' ? Service.TemperatureSensor : Service.HumiditySensor;
	  sensor.accessory = this.getOrCreate(sensor.key, sensor.name, serviceType);
	  desiredUuids.add(sensor.accessory.UUID);
	}

	// Remove any cached accessory that is no longer wanted (a sensor the user
	// switched off, or one removed from the plugin) so its Home app tile goes away.
	for (const [uuid, accessory] of this.accessories) {
	  if (!desiredUuids.has(uuid)) {
		this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
		this.accessories.delete(uuid);
		this.log(`Removed disabled accessory: ${accessory.displayName}`);
	  }
	}
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
	// The /current payload nests readings under sensors[].data[]. Field names
	// (temp, hum, temp_in, hum_in, thw_index) are typical for a Vue but VERIFY
	// them against your own payload. To see the exact shape, log it once:
	//
	//   this.log(JSON.stringify(data, null, 2));   // <- run once, then remove
	//
	// We flatten every sensor block into one object, then read each enabled
	// sensor's field from it. Values are °F / %.
	const merged = {};
	for (const s of (data && data.sensors) || []) {
	  Object.assign(merged, (s.data && s.data[0]) || {});
	}

	for (const sensor of this.activeSensors) {
	  const raw = merged[sensor.field];
	  if (typeof raw !== 'number') continue;

	  if (sensor.kind === 'temp') {
		const tempC = ((raw - 32) * 5) / 9;
		sensor.accessory
		  .getService(Service.TemperatureSensor)
		  .updateCharacteristic(Characteristic.CurrentTemperature, tempC);
	  } else {
		sensor.accessory
		  .getService(Service.HumiditySensor)
		  .updateCharacteristic(Characteristic.CurrentRelativeHumidity, raw);
	  }
	}
  }
}