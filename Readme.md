# homebridge-weatherlink-cloud

A custom [Homebridge](https://homebridge.io) dynamic platform plugin that polls
the **Davis WeatherLink v2 cloud API** and exposes your weather station readings
to Apple HomeKit.

Built for setups where the data lives in the WeatherLink cloud (e.g. a Vantage Vue on a 6313 WeatherLink Console, which has no local API). Any station that uploads to weatherlink.com is reachable this way.

## What it exposes

Each sensor below is a separate HomeKit accessory and can be switched on or off individually in the plugin settings.

| Reading              | HomeKit service     | Notes                                  |
|----------------------|---------------------|----------------------------------------|
| Outdoor temperature  | `TemperatureSensor` | native, shown in the Home app          |
| Outdoor humidity     | `HumiditySensor`    | native                                 |
| Indoor temperature   | `TemperatureSensor` | from the console's built-in sensor     |
| Indoor humidity      | `HumiditySensor`    | from the console's built-in sensor     |
| Feels like (THW)     | `TemperatureSensor` | Davis temperature-humidity-wind index  |

Wind, rainfall, barometric pressure, and UV are **not exposed yet** — HomeKit has no native service for them, so they need Eve custom characteristics (planned).

## Requirements

- Homebridge v1.6+ or v2
- Node.js 18, 20, 22, or 24
- A WeatherLink account with a v2 API key and secret

## Installation

Install **WeatherLink Cloud** from the Homebridge UI plugin screen, or:

```bash
npm install -g homebridge-weatherlink-cloud
```

## Configuration

Get your **API Key** and **API Secret** from the lower-left of your account page
at <https://www.weatherlink.com/account>.

The easiest path is the Homebridge UI: open the plugin's settings, enter your key and secret, and click **Fetch Station ID from account** — the plugin looks up your station and fills in the ID for you. If your account has more than one station, you'll get a list to choose from.

You can also configure it manually. Every option except the API key and secret is optional:

| Option            | Default            | Description                                                            |
|-------------------|--------------------|------------------------------------------------------------------------|
| `apiKey`          | —                  | v2 API key (required).                                                  |
| `apiSecret`       | —                  | v2 API secret (required).                                               |
| `stationId`       | auto-discovered    | Leave blank to detect automatically; set it to pin a specific station. |
| `pollMinutes`     | `15`               | How often to poll. Match your tier (~15 free, ~5 Pro).                  |
| `manufacturer`    | `Davis Instruments`| Shown in the Home app accessory details.                               |
| `model`           | `Vantage Vue`      | Shown in the Home app accessory details.                               |
| `enableOutdoorTemp`     | `true`       | Expose outdoor temperature.                                            |
| `enableOutdoorHumidity` | `true`       | Expose outdoor humidity.                                               |
| `enableIndoorTemp`      | `true`       | Expose indoor temperature.                                            |
| `enableIndoorHumidity`  | `true`       | Expose indoor humidity.                                                |
| `enableFeelsLike`       | `true`       | Expose the THW "feels like" sensor.                                    |

Example `config.json` platform block:

```json
{
  "platforms": [
	{
	  "platform": "WeatherLinkCloud",
	  "name": "WeatherLink",
	  "apiKey": "YOUR_V2_API_KEY",
	  "apiSecret": "YOUR_V2_API_SECRET",
	  "pollMinutes": 15,
	  "enableFeelsLike": true
	}
  ]
}
```

To find the Station ID outside the UI, you can call the API directly:

```bash
curl -H "X-Api-Secret: YOUR_SECRET" \
  "https://api.weatherlink.com/v2/stations?api-key=YOUR_KEY"
```

## Data freshness

The v2 `/current` endpoint returns roughly the last archive record, so values can
lag by up to your upload interval. The update rate is tied to your weatherlink.com
tier (~15 min free, ~5 min Pro), so there's no benefit to polling faster than the
data refreshes. Because of this lag, the plugin isn't suited to time-critical
automations — for those you'd want a WeatherLink Live and its local API.

## Turning sensors on and off

Each sensor has an enable toggle in the settings form. Switching one off removes
its HomeKit accessory on the next restart (the Home app tile disappears rather
than going to "No Response"). Note that removing an accessory drops any
automations or room assignments tied to it; turning it back on creates a fresh
accessory that you may need to re-add to automations.

## Verifying sensor field names

The payload field names (`temp`, `hum`, `temp_in`, `hum_in`, `thw_index`) are the
standard Davis names, but if a sensor tile stays empty, the field may differ for
your hardware. Temporarily enable the payload-dump line in `applyData()`, restart,
and read the logged JSON to confirm the exact names before relying on a reading.

## License

MIT