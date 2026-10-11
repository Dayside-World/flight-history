# Flight history

Which aircraft flew a flight, from [adsb.lol](https://adsb.lol)'s open archive of what aircraft broadcast.

Dayside Flights uses this to fill in the aircraft on flights more than a year old, which is as far back as flight schedules go. This repository is the code that builds the index the app's server reads, and the code that answers a question from it.

## The data

adsb.lol's volunteers run radio receivers that record ADS-B, the position and call sign aircraft broadcast in the clear. adsb.lol publishes every day it has recorded since March 2023 as a GitHub release ([2023](https://github.com/adsblol/globe_history_2023), [2024](https://github.com/adsblol/globe_history_2024), [2025](https://github.com/adsblol/globe_history_2025), [2026](https://github.com/adsblol/globe_history_2026)) under the [Open Database License (ODbL 1.0)](https://opendatacommons.org/licenses/odbl/1-0/).

The index built here is a derivative database. Section 4.6 of the ODbL asks that anyone given something made from it be offered the derivative database or the method of making it. This repository is that method.

## What the index holds

Each day's release is 2 to 3 GB: a tar of one gzipped trace per aircraft. `indexer.mjs` streams it without storing it, and keeps the airline legs:

```
history/v1/<day>/<airline ICAO>.json.gz   [[call sign, ICAO address, registration, type, take-off, landing, from, to], ...]
history/v1/<day>/_day.json                the day's counts, written last
```

Times are Unix seconds, and `from` and `to` are IATA airport codes, or `null` where the aircraft was not seen leaving or arriving. A day comes to about 2.5 MB. Positions are used to find airports and then dropped.

A leg is each time an aircraft climbed away from an airport and came back down. Real days needed more than that, and each case has a test:

- Many airports have no receiver that sees the ground, so a landing often shows as a silence below 5,000 ft rather than a "ground" report. Fifteen quiet minutes down there count as a landing and a take-off.
- A taxiing aircraft at a high airport reports its altitude instead of "ground". A leg has to climb 2,000 ft and last five minutes.
- Coverage can be one city. If an aircraft goes silent for longer than it could have spent flying the distance between sightings, it landed somewhere unseen, and that end of the leg stays unknown.
- Each day stops at midnight UTC, sometimes mid-flight. That end is unknown, and the two halves are joined again when a question spans them.

## Answering a question

`matchFlight` in `history.mjs` takes a flight number, its local date, and where it flew and when it was scheduled to leave, if known:

1. **By call sign.** `NZ29` flies as `ANZ29`, sometimes with a letter on the end (`AUA501C`). The take-off has to fall on the asked day at the departure airport. A leg whose departure nobody saw has to be in the air after the scheduled departure and within twenty hours of it.
2. **By route and time.** Some airlines' call signs are not their flight numbers: British Airways 547 flies as `BAW8CF`. These are matched to that airline's aircraft on that route, seen at both ends, nearest the scheduled departure and within ninety minutes of it. If there is no time and more than one candidate, the answer is nothing. It never guesses.

A flight sold under a partner's number broadcasts the operating airline's call sign, so it isn't found.

## Running it

Node 22 or later. No dependencies, except `@aws-sdk/client-s3` to write to S3.

```sh
node indexer.mjs 2024-05-15 --out ./index     # one day, to a folder
node --test 'test/*.test.mjs'                 # the tests
```

As an AWS Lambda, `indexer.handler` takes `{ "date": "2024-05-15" }` and writes to the bucket named by `HISTORY_BUCKET`.

## Licences

- The code is under the MIT licence (`LICENSE`).
- Flight data: adsb.lol, ODbL 1.0. This includes the two traces in `fixtures/`.
- Airports: `data/airports.csv`, from [OurAirports](https://ourairports.com) (public domain).
- Airlines: `data/airlines.csv`, from [Open Travel Data](https://github.com/opentraveldata/opentraveldata), used under CC BY 4.0 and filtered to the airlines the app needs.

See `NOTICE`.

This repository is published from the Dayside Flights source and updated when the code changes there.
