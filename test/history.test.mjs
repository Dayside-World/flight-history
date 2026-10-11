import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  HISTORY_START, airportFinder, answerFor, callsignParts, csv, daysAround, indexDay, isHistoryDate, joinDays,
  legsOfTrace, loadTables, localDay, matchFlight, readTrace, tarEntries,
} from "../history.mjs";
import { releaseParts } from "../indexer.mjs";

const tables = loadTables();
const nearest = airportFinder(tables.airports);
const at = (iso) => Date.parse(iso) / 1000;

/**
 * Real traces from adsb.lol's archive for 2024-05-15 (ODbL 1.0), aircraft that have nothing to do
 * with anyone's logbook: a Delta 737 seen at every airport it used, and an Azul E195 seen only
 * near São Paulo, at cruise, with nine hours unseen between.
 */
const real = (name) => readTrace(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

/** The app's own copies, beside these in the Dayside Flights repository; absent where this is published alone. */
const appTables = new URL("../../../Packages/FlightsCore/Sources/FlightsCore/Resources/", import.meta.url);

test("the proxy's tables are the app's tables", () => {
  for (const name of existsSync(appTables) ? ["airports.csv", "airlines.csv"] : []) {
    const ours = readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8");
    const app = readFileSync(new URL(name, appTables), "utf8");
    assert.equal(ours, app, `${name} has drifted from the app's; copy it again`);
  }
  assert.ok(tables.airports.length > 3000);
  assert.deepEqual(tables.airlines.filter((airline) => airline.iata === "NZ").map((airline) => airline.icao), ["ANZ"]);
});

test("csv reads quoted fields", () => {
  assert.deepEqual(csv('a,b\n"x, y","say ""hi"""\n'), [{ a: "x, y", b: 'say "hi"' }]);
});

test("a real day's legs, where every airport saw it", () => {
  const legs = legsOfTrace(real("trace-N3765-2024-05-15.json.gz"), nearest);
  assert.deepEqual(legs.map((leg) => [leg.callsign, leg.from, leg.to]), [
    ["DAL2232", "ATL", "LEX"], ["DAL2232", "LEX", "ATL"], ["DAL2151", "ATL", "CVG"],
  ]);
  assert.equal(legs[0].registration, "N3765");
  assert.equal(legs[0].type, "B738");
});

test("a real day seen only around one city: what is unseen stays unknown", () => {
  const legs = legsOfTrace(real("trace-PR-AUP-2024-05-15.json.gz"), nearest);
  // Before: three legs from São Paulo to São Paulo, fifteen hours long.
  assert.ok(legs.every((leg) => !(leg.from === "GRU" && leg.to === "GRU")));
  assert.deepEqual(legs.filter((leg) => leg.from === "GRU").map((leg) => leg.callsign), ["AZU4832", "AZU4830", "AZU4390"]);
  assert.deepEqual(legs.filter((leg) => leg.to === "GRU").map((leg) => leg.callsign), ["AZU2818", "AZU4965", "AZU2605"]);
});

/** A trace as readsb writes one: rows of [seconds, lat, lon, alt | "ground", speed, track, flags, vrate, details]. */
function trace(rows, extra = {}) {
  return { icao: "c81d82", r: "ZK-OKO", t: "B77W", timestamp: at("2024-05-15T00:00:00Z"), trace: rows, ...extra };
}
const akl = [-37.008, 174.792];
const chc = [-43.489, 172.532];
const row = (seconds, [lat, lon], alt, speed, flight, vrate = 0) =>
  [seconds, lat, lon, alt, speed, 0, 0, vrate, flight ? { flight: flight.padEnd(8) } : null];

test("a leg climbs away and comes down; a taxi is not one", () => {
  const legs = legsOfTrace(trace([
    row(3600, akl, "ground", 10, "ANZ521"),
    row(3700, akl, 400, 150, null, 2000),
    row(4500, [-40, 174], 30000, 450),
    row(6600, chc, 600, 140, null, -800),
    row(6700, chc, "ground", 20),
    row(9000, chc, 1800, 40),
    row(9100, chc, 1800, 30),
  ]), nearest);
  assert.deepEqual(legs.map((leg) => [leg.callsign, leg.from, leg.to]), [["ANZ521", "AKL", "CHC"]]);
});

test("a silence low down is a landing and a take-off nobody saw", () => {
  const legs = legsOfTrace(trace([
    row(3700, akl, 1500, 150, "ANZ521", 2000),
    row(4500, [-40, 174], 30000, 450),
    row(6600, chc, 1500, 140, null, -800),
    row(8000, chc, 1500, 150, "ANZ578", 1500),
    row(9000, [-40, 174], 30000, 450),
    row(10800, akl, 1500, 140, null, -800),
  ]), nearest);
  assert.deepEqual(legs.map((leg) => [leg.callsign, leg.from, leg.to]), [["ANZ521", "AKL", "CHC"], ["ANZ578", "CHC", "AKL"]]);
});

test("midnight is not an airport, and the two halves join again", () => {
  const before = legsOfTrace(trace([
    row(85000, akl, 1500, 150, "ANZ29", 2000),
    row(86390, [-30, -170], 36000, 480),
  ]), nearest);
  assert.equal(before[0].to, null, "still flying when the day ended");
  const after = legsOfTrace(trace([
    row(10, [-30, -169.9], 36000, 480, "ANZ29"),
    row(30000, [29.98, -95.34], 1200, 140, null, -700),
  ], { timestamp: at("2024-05-16T00:00:00Z") }), nearest);
  assert.equal(after[0].from, null, "already flying when the day began");
  const rows = (legs) => legs.map((leg) => [leg.callsign, leg.hex, leg.registration, leg.type, leg.takeoff, leg.landing, leg.from, leg.to]);
  const joined = joinDays([rows(before), rows(after)]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].from, "AKL");
  assert.equal(joined[0].to, "IAH");
});

test("a tar stream is read a file at a time, however it arrives", async () => {
  const file = (name, body) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    header.write("0", 156);
    return Buffer.concat([header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]);
  };
  const flown = trace([row(3600, akl, "ground", 10, "ANZ521"), row(3700, akl, 400, 150, null, 2000),
    row(4500, [-40, 174], 30000, 450), row(6600, chc, 600, 140, null, -800), row(6700, chc, "ground", 20)]);
  const archive = Buffer.concat([
    file("./README.txt", Buffer.from("hello")),
    file("./traces/82/trace_full_c81d82.json", gzipSync(JSON.stringify(flown))),
    Buffer.alloc(1024),
  ]);
  async function* dribble() {
    for (let i = 0; i < archive.length; i += 77) yield new Uint8Array(archive.subarray(i, i + 77));
  }
  const names = [];
  for await (const entry of tarEntries(dribble())) names.push(entry.name);
  assert.deepEqual(names, ["./README.txt", "./traces/82/trace_full_c81d82.json"]);

  const { manifest, airlines } = await indexDay(dribble(), "2024-05-15", tables);
  assert.equal(manifest.traces, 1);
  assert.deepEqual(airlines.get("ANZ").map((leg) => [leg[0], leg[2], leg[3], leg[6], leg[7]]), [["ANZ521", "ZK-OKO", "B77W", "AKL", "CHC"]]);
});

// ── Answering ──

/** Legs as `joinDays` gives them. */
const leg = (callsign, from, to, takeoff, registration = "ZK-OKW", type = "B77W") =>
  ({ callsign, hex: registration, registration, type, takeoff: at(takeoff), landing: at(takeoff) + 3600, from, to });

test("the call sign finds the flight, with a letter on the end or without", () => {
  const legs = [
    leg("ANZ29", "IAH", "AKL", "2023-12-23T02:33:00Z"),
    leg("AUA501C", "VIE", "FCO", "2024-05-13T04:51:00Z", "OE-LBF", "A321"),
    leg("AUA5011", "VIE", "FCO", "2024-05-13T04:51:00Z", "OE-LBX", "A321"),
  ];
  // NZ29 leaves Houston on the evening of the 22nd, local: the 23rd in UTC.
  assert.equal(matchFlight(legs, { flight: "NZ29", date: "2023-12-22" }, tables)?.registration, "ZK-OKW");
  assert.equal(matchFlight(legs, { flight: "NZ29", date: "2023-12-23" }, tables), null, "the wrong local day");
  assert.equal(matchFlight(legs, { flight: "OS501", date: "2024-05-13", from: "VIE", to: "FCO" }, tables)?.registration, "OE-LBF");
  assert.equal(matchFlight(legs, { flight: "NZ29", date: "2023-12-22", from: "AKL", to: "IAH" }, tables), null, "another route");
});

test("a leg first seen in the air is placed by the scheduled departure, not by when it was seen", () => {
  // Delta 196, Seoul 20:05 KST on 22 March (11:05 UTC), unseen until near Seattle. Its first
  // sighting falls on the 23rd in Seoul, and the day before's falls on the 22nd (2023-03-21..23).
  const legs = [
    leg("DAL196", null, "SEA", "2023-03-21T20:39:00Z", "N419DX", "A339"),
    leg("DAL196", null, "SEA", "2023-03-22T20:38:00Z", "N418DX", "A339"),
    leg("DAL196", null, "SEA", "2023-03-23T16:55:00Z", "N419DX", "A339"),
  ];
  const question = { flight: "DL196", date: "2023-03-22", from: "ICN", to: "SEA" };
  assert.equal(matchFlight(legs, { ...question, at: "2023-03-22T11:05:00Z" }, tables)?.registration, "N418DX");
  assert.equal(matchFlight(legs, question, tables), null, "no scheduled time: too uncertain to say");
});

test("a call sign that is not the flight number is found by route and time", () => {
  const legs = [
    leg("BAW5PQ", "LHR", "FCO", "2024-05-15T10:30:00Z", "G-EUYV", "A320"),
    leg("BAW8CF", "FCO", "LHR", "2024-05-15T14:05:00Z", "G-EUYV", "A320"),
    leg("BAW1RT", "FCO", "LHR", "2024-05-15T18:40:00Z", "G-EUYW", "A320"),
  ];
  const question = { flight: "BA547", date: "2024-05-15", from: "FCO", to: "LHR" };
  assert.equal(matchFlight(legs, { ...question, at: "2024-05-15T14:00:00Z" }, tables)?.callsign, "BAW8CF");
  assert.equal(matchFlight(legs, question, tables), null, "two candidates and no time: not a guess");
  assert.equal(matchFlight(legs, { ...question, at: "2024-05-15T08:00:00Z" }, tables), null, "nothing within ninety minutes");
});

test("the answer is the aeroplane, never the times", () => {
  const question = { flight: "OS501", date: "2024-05-13", from: "VIE", to: "FCO" };
  const answer = answerFor(question, leg("AUA501C", "VIE", null, "2024-05-13T04:51:00Z", "OE-LBF", "A321"));
  assert.deepEqual(answer, {
    flight: "OS501", date: "2024-05-13",
    legs: [{ number: "OS501", origin: { iata: "VIE" }, destination: { iata: "FCO" }, aircraft: "Airbus A321", registration: "OELBF" }],
  });
  assert.deepEqual(answerFor(question, null).legs, []);
  const unknownType = answerFor(question, leg("AUA501C", "VIE", "FCO", "2024-05-13T04:51:00Z", "OE-LBF", "ZZZZ"));
  assert.ok(!("aircraft" in unknownType.legs[0]), "a designator it does not know is left out, not guessed");
});

test("the archive answers for what the schedule no longer does", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  assert.equal(isHistoryDate("2025-10-11", now), false, "the schedule's year");
  assert.equal(isHistoryDate("2025-10-10", now), true);
  assert.equal(isHistoryDate(HISTORY_START, now), true);
  assert.equal(isHistoryDate("2023-03-10", now), false, "before the archive");
  assert.equal(isHistoryDate("someday", now), false);
  assert.deepEqual(daysAround("2024-03-01"), ["2024-02-29", "2024-03-01", "2024-03-02"]);
  assert.equal(localDay(at("2023-12-23T02:33:00Z"), "America/Chicago"), "2023-12-22");
  assert.deepEqual(callsignParts("NZ029", tables.airlines), { icao: ["ANZ"], number: "29" });
  assert.deepEqual(callsignParts("ANZ29", tables.airlines), { icao: ["ANZ"], number: "29" });
  assert.equal(callsignParts("ZZ1", tables.airlines), null);
});

test("a day's release is found by asking for its parts", async () => {
  const there = new Set([
    "https://github.com/adsblol/globe_history_2024/releases/download/v2024.05.15-planes-readsb-prod-0/v2024.05.15-planes-readsb-prod-0.tar.aa",
    "https://github.com/adsblol/globe_history_2024/releases/download/v2024.05.15-planes-readsb-prod-0/v2024.05.15-planes-readsb-prod-0.tar.ab",
    "https://github.com/adsblol/globe_history_2023/releases/download/v2023.10.15-planes-readsb-staging-0/v2023.10.15-planes-readsb-staging-0.tar",
  ]);
  const fetcher = async (url) => ({ ok: there.has(url) });
  assert.equal((await releaseParts("2024-05-15", fetcher)).length, 2);
  assert.match((await releaseParts("2023-10-15", fetcher))[0], /staging-0\.tar$/);
  assert.deepEqual(await releaseParts("2024-01-01", fetcher), []);
});
