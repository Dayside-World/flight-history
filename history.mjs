/**
 * Which aeroplane flew a flight more than a year ago (decision 027), from adsb.lol's open archive
 * of what aircraft broadcast (`globe_history`, ODbL 1.0): one release per day since March 2023.
 *
 * Two halves, both pure so they are tested without AWS (`test/history.test.mjs`):
 *
 *   - **Indexing.** A day's archive (2–3 GB, a tar of one gzipped trace per aircraft) is read as a
 *     stream and reduced to its airline legs: call sign, aircraft, registration, type, take-off and
 *     landing, and the airports nearest where it left the ground and came back to it. That is the
 *     index the proxy reads (`indexer.mjs` writes one per day).
 *   - **Matching.** A question (a flight number, its local day, and where it went and when, if
 *     known) is answered from the index: by call sign first (`ANZ29`, or `AUA501C` with a letter on
 *     the end), and failing that, for airlines whose call signs are not their flight numbers
 *     (`BAW8CF` for BA 547), by airline, route and take-off time.
 *
 * What it keeps is what flew: an aeroplane, which is a fact once it has flown (decision 003 forbids
 * live status, and none of this is live). Positions are used to find airports and then dropped.
 */
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** The first day the archive holds a full day (it began on 2023-03-10, with almost nothing). */
export const HISTORY_START = "2023-03-11";

// ── Tables ──────────────────────────────────────────────────────────────────────────────────────

/** The app's own airport and airline tables, copied (`data/`, kept identical by a test). */
export function loadTables(dir = new URL("./data/", import.meta.url)) {
  const airports = csv(readFileSync(new URL("airports.csv", dir), "utf8"))
    .map((row) => ({ iata: row.iata, lat: Number(row.lat), lon: Number(row.lon), tz: row.tz }))
    .filter((airport) => /^[A-Z]{3}$/.test(airport.iata) && Number.isFinite(airport.lat));
  const airlines = csv(readFileSync(new URL("airlines.csv", dir), "utf8"))
    .filter((row) => /^[A-Z]{3}$/.test(row.icao) && /^[A-Z0-9]{2}$/.test(row.iata));
  return { airports, airlines };
}

/** RFC 4180, as far as these tables need: quoted fields, doubled quotes. */
export function csv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((name, i) => [name, values[i] ?? ""])));
}

/** Nearest airport to a point, within `km`: a one-degree grid, so a day's hundred thousand legs are quick. */
export function airportFinder(airports) {
  const grid = new Map();
  for (const airport of airports) {
    const key = `${Math.floor(airport.lat)}:${Math.floor(airport.lon)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(airport);
  }
  return (lat, lon, km = 8) => {
    let best = null, bestKm = km;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const lonCell = ((Math.floor(lon) + dx + 180 + 360) % 360) - 180;
        for (const airport of grid.get(`${Math.floor(lat) + dy}:${lonCell}`) ?? []) {
          const d = distanceKm(lat, lon, airport.lat, airport.lon);
          if (d <= bestKm) { best = airport; bestKm = d; }
        }
      }
    }
    return best;
  };
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// ── Reading the archive ─────────────────────────────────────────────────────────────────────────

/**
 * The files in a tar stream, one at a time, without holding the archive: the archive is 2–3 GB and
 * the files in it a few kilobytes each. Plain ustar, plus the GNU long-name and pax headers. Takes
 * any async iterable of bytes: a file, a pipe, a fetch body.
 */
export async function* tarEntries(stream) {
  const chunks = [];
  let buffered = 0;
  const take = (n) => {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = chunks[0];
      const used = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, used);
      filled += used;
      if (used === head.length) chunks.shift(); else chunks[0] = head.subarray(used);
    }
    buffered -= n;
    return out;
  };
  const iterator = stream[Symbol.asyncIterator]();
  const need = async (n) => {
    while (buffered < n) {
      const { value, done } = await iterator.next();
      if (done) return false;
      // A fetch body yields Uint8Arrays; the copying below wants Buffers, and these share memory.
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(chunk);
      buffered += chunk.length;
    }
    return true;
  };
  let longName = null;
  while (await need(512)) {
    const header = take(512);
    if (header.every((byte) => byte === 0)) continue;
    const size = parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString("latin1").replace(/\0.*$/, "");
    let name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;
    const padded = Math.ceil(size / 512) * 512;
    if (!(await need(padded))) return;
    const body = take(padded).subarray(0, size);
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/, ""); continue; }
    if (type === "x") {
      const path = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if (type === "0" || type === "\0") yield { name, body };
  }
}

/** A trace file's JSON, gzipped or not (the archive has both). */
export function readTrace(body) {
  const text = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  return JSON.parse(text.toString("utf8"));
}

/** Airline call signs: three letters and a number, perhaps with letters after (`BAW8CF`, `AUA501C`). */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d[0-9A-Z]{0,4}$/;

/**
 * One aircraft's day as legs: each time it climbed away from an airport and came back down, under
 * the call sign it flew most of that time. A leg cut by midnight, or by a gap in coverage, keeps
 * the airport it has and leaves the other unknown.
 *
 * readsb's trace rows are `[seconds after timestamp, lat, lon, altitude ft | "ground", ground
 * speed kt, track, flags, vertical rate ft/min, details | null, …]`, the call sign in
 * `details.flight` when it changes. What real days taught it (2024-05-15):
 *
 *   - Many airports have no receiver that sees the ground, so a landing is often a silence low
 *     down rather than a "ground" row: fifteen quiet minutes below 5,000 ft is a landing and a
 *     take-off.
 *   - A taxiing aircraft at a high airport reports its altitude, not "ground" (São Paulo is 2,300
 *     ft): a leg has to climb 2,000 ft and last five minutes to be a flight.
 *   - Coverage can be one city: an aircraft seen leaving São Paulo and seen again nine hours
 *     later a hundred kilometres away flew other legs unseen. A silence it could not have spent
 *     flying (covering under half the distance its speed allows) ends the leg.
 *   - The day ends at midnight UTC, mid-flight or mid-climb: that end is unknown, not an airport.
 */
export function legsOfTrace(trace, nearestAirport) {
  const start = Number(trace.timestamp) || 0;
  const dayEnd = start + 86400;
  const rows = Array.isArray(trace.trace) ? trace.trace : [];
  const legs = [];
  let callsign = null;
  let lastGround = null;
  let leg = null;

  /** The airport a point is at: on the ground there, or low, near and climbing from (or sinking to) it. */
  const airportAt = (point, leaving) => {
    if (!point) return null;
    const near = nearestAirport(point.lat, point.lon, 8);
    if (!near || point.ground) return near?.iata ?? null;
    const low = point.alt < 3000 || (point.alt < 12000 && distanceKm(point.lat, point.lon, near.lat, near.lon) < 4);
    const heading = point.vrate === null || (leaving ? point.vrate >= -300 : point.vrate <= 300);
    return low && heading ? near.iata : null;
  };

  const close = (landing) => {
    if (!leg) return;
    const flown = [...leg.callsigns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const climbed = leg.maxAlt >= 3000 && leg.maxAlt - Math.min(leg.first.alt, leg.last.alt) >= 2000;
    const lasted = leg.last.time - leg.first.time >= 300;
    if (flown && AIRLINE_CALLSIGN.test(flown) && climbed && lasted) {
      const cutAtMidnight = !landing && dayEnd - leg.last.time < 600;
      legs.push({
        callsign: flown,
        hex: trace.icao,
        registration: trace.r ?? null,
        type: trace.t ?? null,
        takeoff: Math.round(leg.first.time),
        landing: Math.round(leg.last.time),
        from: leg.from,
        to: landing ? airportAt(landing, false) : cutAtMidnight ? null : airportAt(leg.last, false),
      });
    }
    leg = null;
  };

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4 || !Number.isFinite(row[1]) || !Number.isFinite(row[2])) continue;
    const details = row[8];
    if (details && typeof details === "object" && typeof details.flight === "string") {
      const named = details.flight.trim();
      if (named && !named.startsWith("@")) callsign = named;
    }
    const speed = typeof row[4] === "number" ? row[4] : null;
    const ground = row[3] === "ground" || (typeof row[3] === "number" && speed !== null && speed < 45);
    const point = {
      time: start + Number(row[0]),
      lat: row[1],
      lon: row[2],
      alt: typeof row[3] === "number" ? row[3] : 0,
      vrate: typeof row[7] === "number" ? row[7] : null,
      speed,
      ground,
    };
    if (ground) {
      if (leg) close(point);
      lastGround = point;
      continue;
    }
    if (leg) {
      const gap = point.time - leg.last.time;
      const quietLowDown = gap > 900 && leg.last.alt < 5000 && point.alt < 5000;
      const renamed = callsign && leg.callsign && callsign !== leg.callsign && gap > 600;
      const kmPerSecond = (Math.max(leg.last.speed ?? 0, point.speed ?? 0) * 1.852) / 3600;
      const stoppedSomewhere = gap > 1800 && kmPerSecond > 0
        && distanceKm(leg.last.lat, leg.last.lon, point.lat, point.lon) < 0.5 * kmPerSecond * gap;
      if (quietLowDown || renamed || stoppedSomewhere) close(null);
    }
    if (!leg) {
      const fromGround = lastGround && point.time - lastGround.time < 1800 ? lastGround : null;
      const fromMidnight = !fromGround && point.time - start < 600;
      leg = {
        first: point,
        last: point,
        maxAlt: point.alt,
        from: fromMidnight ? null : airportAt(fromGround ?? point, true),
        callsigns: new Map(),
        callsign,
      };
      lastGround = null;
    }
    leg.last = point;
    leg.maxAlt = Math.max(leg.maxAlt, point.alt);
    leg.callsign = callsign;
    if (callsign) leg.callsigns.set(callsign, (leg.callsigns.get(callsign) ?? 0) + 1);
  }
  close(null);
  return legs;
}

/**
 * A day's archive into its index, by airline: `{ manifest, airlines: Map<"ANZ", [[callsign, hex,
 * registration, type, takeoff, landing, from, to]]> }`, times in Unix seconds. Split by the call
 * sign's airline because every question is about one airline, so an answer reads kilobytes, not
 * the day. Only airlines the app knows (`airlines.csv`) are kept: it can ask about no others.
 */
export async function indexDay(stream, day, { airports, airlines }) {
  const nearest = airportFinder(airports);
  const known = new Set(airlines.map((airline) => airline.icao));
  const byAirline = new Map();
  let traces = 0, legs = 0;
  for await (const entry of tarEntries(stream)) {
    if (!entry.name.includes("trace_full")) continue;
    let trace;
    try {
      trace = readTrace(entry.body);
    } catch {
      continue;
    }
    traces += 1;
    for (const leg of legsOfTrace(trace, nearest)) {
      const airline = leg.callsign.slice(0, 3);
      if (!known.has(airline)) continue;
      if (!byAirline.has(airline)) byAirline.set(airline, []);
      byAirline.get(airline).push([leg.callsign, leg.hex, leg.registration, leg.type, leg.takeoff, leg.landing, leg.from, leg.to]);
      legs += 1;
    }
  }
  const manifest = { day, source: "adsb.lol globe_history", license: "ODbL-1.0", traces, legs, airlines: byAirline.size };
  return { manifest, airlines: byAirline };
}

// ── Answering ───────────────────────────────────────────────────────────────────────────────────

/** UTC days, as `YYYY-MM-DD`, either side of a local day: a local day touches three UTC ones. */
export function daysAround(date) {
  const day = Date.parse(`${date}T00:00:00Z`);
  return [-1, 0, 1].map((offset) => new Date(day + offset * 86400000).toISOString().slice(0, 10));
}

/** Whether the archive, not the schedule, answers for this day: before AeroDataBox's year, after March 2023. */
export function isHistoryDate(date, now = new Date()) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = Date.parse(`${date}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Number.isFinite(day) && date >= HISTORY_START && (day - today) / 86400000 < -364;
}

/** Rows from consecutive days' index files as legs, with any leg midnight cut in two put back together. */
export function joinDays(rowsByDay) {
  const legs = rowsByDay.flat().map((row) => ({
    callsign: row[0], hex: row[1], registration: row[2], type: row[3], takeoff: row[4], landing: row[5],
    from: row[6], to: row[7],
  }));
  legs.sort((a, b) => a.takeoff - b.takeoff);
  const joined = [];
  const latest = new Map();
  for (const leg of legs) {
    const previous = latest.get(leg.hex);
    const midnight = previous && leg.takeoff % 86400 < 900 && previous.landing % 86400 > 85500;
    if (midnight && previous.callsign === leg.callsign && !previous.to && !leg.from && leg.takeoff - previous.landing < 1800) {
      previous.landing = leg.landing;
      previous.to = leg.to;
    } else {
      const copy = { ...leg };
      joined.push(copy);
      latest.set(leg.hex, copy);
    }
  }
  return joined;
}

/** `NZ29` → its call signs' carrier codes (`ANZ`) and number (`29`); `ANZ29` is taken as given. */
export function callsignParts(flight, airlines) {
  const match = /^([A-Z0-9]{2,3}?)(\d{1,4})([A-Z]?)$/.exec(flight);
  if (!match) return null;
  const [, carrier, digits] = match;
  const icao = carrier.length === 3 && /^[A-Z]{3}$/.test(carrier)
    ? [carrier]
    : airlines.filter((airline) => airline.iata === carrier).map((airline) => airline.icao);
  return icao.length ? { icao, number: String(Number(digits)) } : null;
}

/** The local calendar day at `tz` of a Unix time. */
export function localDay(seconds, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(seconds * 1000));
  } catch {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
}

/**
 * The leg that is this flight, from the legs of the days around it, or `null`.
 *
 * @param question `{ flight, date, from?, to?, at? }`: `at` the scheduled departure as an ISO time.
 */
export function matchFlight(legs, question, { airlines, airports }) {
  const parts = callsignParts(question.flight, airlines);
  if (!parts) return null;
  const zones = new Map(airports.map((airport) => [airport.iata, airport.tz]));
  const at = question.at ? Date.parse(question.at) / 1000 : null;
  // A leg seen leaving has a take-off: it is on the day if it left on the day, and near the
  // scheduled time if there is one. A leg first seen in the air (Delta 196, unseen over Korea, first
  // seen near Seattle) has only a first sighting, which can fall on the next local day: it is on
  // the day if it was in the air after the scheduled departure and within twenty hours of it, and
  // with no scheduled time it is too uncertain to say.
  const onTheDay = (leg) => {
    if (leg.from) {
      return localDay(leg.takeoff, zones.get(leg.from) ?? "UTC") === question.date
        && (at === null || Math.abs(leg.takeoff - at) <= 12 * 3600);
    }
    return at !== null && leg.takeoff >= at - 3600 && leg.takeoff <= at + 20 * 3600;
  };
  const sameRoute = (leg) => (!question.from || !leg.from || leg.from === question.from)
    && (!question.to || !leg.to || leg.to === question.to);
  const closest = (candidates) => {
    if (candidates.length <= 1 || at === null) return candidates[0] ?? null;
    return [...candidates].sort((a, b) => Math.abs(a.takeoff - at) - Math.abs(b.takeoff - at))[0];
  };

  const byCallsign = legs.filter((leg) => parts.icao.some((icao) => {
    const rest = leg.callsign.startsWith(icao) ? leg.callsign.slice(icao.length) : null;
    const number = rest && /^0*(\d+)[A-Z]?$/.exec(rest);
    return number && number[1] === parts.number;
  }) && onTheDay(leg) && sameRoute(leg));
  if (byCallsign.length) return closest(byCallsign);

  // Call signs that are not flight numbers (BAW8CF): the airline's aeroplane that flew this route,
  // seen at both ends, nearest the scheduled time and within ninety minutes of it.
  if (!question.from || !question.to) return null;
  const byRoute = legs.filter((leg) => parts.icao.some((icao) => leg.callsign.startsWith(icao))
    && leg.from === question.from && leg.to === question.to && onTheDay(leg)
    && (at === null || Math.abs(leg.takeoff - at) <= 5400));
  if (at === null && byRoute.length !== 1) return null;
  return closest(byRoute);
}

/**
 * The proxy's answer for a matched leg, in the shape `flights.mjs` gives (decision 026): the
 * aeroplane and its registration, no times. A flown flight's times are the person's to keep, and
 * what was broadcast is when it took off, not when it was scheduled to.
 */
export function answerFor(question, leg) {
  if (!leg) return { flight: question.flight, date: question.date, legs: [] };
  const from = leg.from ?? question.from;
  const to = leg.to ?? question.to;
  if (!from || !to) return { flight: question.flight, date: question.date, legs: [] };
  const aircraft = aircraftName(leg.type);
  return {
    flight: question.flight,
    date: question.date,
    legs: [Object.fromEntries(Object.entries({
      number: question.flight,
      origin: { iata: from },
      destination: { iata: to },
      aircraft,
      registration: leg.registration ? leg.registration.replace(/-/g, "").toUpperCase() : undefined,
    }).filter(([, value]) => value !== undefined))],
  };
}

/** ICAO type designators as people name them, the way the logbook already does ("Boeing 777-300ER"). */
const TYPES = {
  A124: "Antonov An-124", A139: "AgustaWestland AW139",
  A19N: "Airbus A319neo", A20N: "Airbus A320neo", A21N: "Airbus A321neo",
  A306: "Airbus A300-600", A30B: "Airbus A300", A310: "Airbus A310",
  A318: "Airbus A318", A319: "Airbus A319", A320: "Airbus A320", A321: "Airbus A321",
  A332: "Airbus A330-200", A333: "Airbus A330-300", A338: "Airbus A330-800", A339: "Airbus A330-900",
  A342: "Airbus A340-200", A343: "Airbus A340-300", A345: "Airbus A340-500", A346: "Airbus A340-600",
  A359: "Airbus A350-900", A35K: "Airbus A350-1000", A388: "Airbus A380-800",
  AT43: "ATR 42-300", AT45: "ATR 42-500", AT46: "ATR 42-600", AT72: "ATR 72", AT75: "ATR 72-500", AT76: "ATR 72-600",
  B37M: "Boeing 737 MAX 7", B38M: "Boeing 737 MAX 8", B39M: "Boeing 737 MAX 9", B3XM: "Boeing 737 MAX 10",
  B712: "Boeing 717-200", B722: "Boeing 727-200",
  B732: "Boeing 737-200", B733: "Boeing 737-300", B734: "Boeing 737-400", B735: "Boeing 737-500",
  B736: "Boeing 737-600", B737: "Boeing 737-700", B738: "Boeing 737-800", B739: "Boeing 737-900",
  B741: "Boeing 747-100", B742: "Boeing 747-200", B744: "Boeing 747-400", B748: "Boeing 747-8",
  B752: "Boeing 757-200", B753: "Boeing 757-300",
  B762: "Boeing 767-200", B763: "Boeing 767-300", B764: "Boeing 767-400",
  B772: "Boeing 777-200", B77L: "Boeing 777-200LR", B773: "Boeing 777-300", B77W: "Boeing 777-300ER",
  B778: "Boeing 777-8", B779: "Boeing 777-9",
  B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10",
  BCS1: "Airbus A220-100", BCS3: "Airbus A220-300",
  CRJ1: "Bombardier CRJ100", CRJ2: "Bombardier CRJ200", CRJ7: "Bombardier CRJ700",
  CRJ9: "Bombardier CRJ900", CRJX: "Bombardier CRJ1000",
  DH8A: "De Havilland Dash 8-100", DH8B: "De Havilland Dash 8-200", DH8C: "De Havilland Dash 8-300",
  DH8D: "De Havilland Dash 8-400",
  E135: "Embraer ERJ 135", E145: "Embraer ERJ 145", E170: "Embraer 170", E75L: "Embraer 175", E75S: "Embraer 175",
  E190: "Embraer 190", E195: "Embraer 195", E290: "Embraer 190-E2", E295: "Embraer 195-E2",
  F100: "Fokker 100", F70: "Fokker 70",
  MD11: "McDonnell Douglas MD-11", MD82: "McDonnell Douglas MD-82", MD83: "McDonnell Douglas MD-83",
  MD88: "McDonnell Douglas MD-88", MD90: "McDonnell Douglas MD-90",
  RJ85: "Avro RJ85", RJ1H: "Avro RJ100", SF34: "Saab 340", SB20: "Saab 2000",
  SU95: "Sukhoi Superjet 100", C919: "COMAC C919", AJ27: "COMAC ARJ21",
};

/** The designator's name; an unknown designator is left out rather than guessed at. */
export function aircraftName(designator) {
  return designator ? TYPES[designator] : undefined;
}
