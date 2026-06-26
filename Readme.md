# homebridge-weatherlink-cloud

A custom [Homebridge](https://homebridge.io) dynamic platform plugin that polls
the **Davis WeatherLink v2 cloud API** and exposes your weather station readings
to Apple HomeKit.

Built for setups where the data lives in the WeatherLink cloud (e.g. a 6313
WeatherLink Console, which has no local API). Any station that uploads to
weatherlink.com is reachable this way.

## What it exposes

| Reading      | HomeKit service     | Status        |
|--------------|---------------------|---------------|
| Temperature  | `TemperatureSensor` | native ✅      |
| Humidity     | `HumiditySensor`    | native ✅      |
| Wind / rain / pressure / UV | none | needs Eve custom characteristics or a LightSensor hack (not yet implemented) |

## Heads-up on data freshness

The v2 `/current` endpoint returns roughly the last archive record, so values can
lag by up to your upload interval. Update rate is tied to your weatherlink.com
tier (~15 min free, ~5 min Pro). Set `pollMinutes` to match — there is no benefit
to polling faster than the data refreshes.

## Configuration

Get your **API Key** and **API Secret** from the lower-left of your account page
at <https://www.weatherlink.com/account>. Find your numeric **Station ID** with:

```bash
curl -H "X-Api-Secret: YOUR_SECRET" \
  "https://api.weatherlink.com/v2/stations?api-key=YOUR_KEY"
```

Then either use the Settings form in the Homebridge UI, or add a platform block
to `config.json`:

```json
{
  "platforms": [
	{
	  "platform": "WeatherLinkCloud",
	  "name": "WeatherLink",
	  "apiKey": "YOUR_V2_API_KEY",
	  "apiSecret": "YOUR_V2_API_SECRET",
	  "stationId": 123456,
	  "pollMinutes": 15
	}
  ]
}
```

## First run

Uncomment the payload-dump line in `applyData()` once, restart, and read the
logged JSON to confirm the exact field names for your sensors before mapping
anything beyond temp/humidity.

## License

MIT