import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { HISTORY_START, indexDay, loadTables } from "./history.mjs";

/**
 * Indexes adsb.lol's archive one day at a time (decision 027), into the history bucket the proxy
 * reads: `history/v1/<day>/<airline>.json.gz` for each airline, then `history/v1/<day>/_day.json`,
 * written last, so a day with a manifest is a day that is whole.
 *
 *   { "date": "2024-05-15" }   one day, as the backfill asks (`scripts/ci/backfill-history.sh`)
 *   (the daily schedule)        the days about to leave AeroDataBox's year, if not yet indexed
 *
 * Also runs on a laptop, to try a day without AWS: `node indexer.mjs 2024-05-15 --out <dir>`.
 */
export const PREFIX = "history/v1";
const BUCKET = process.env.HISTORY_BUCKET;
const tables = loadTables();

let s3;
async function client() {
  if (!s3) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    s3 = new S3Client({});
  }
  return s3;
}

export const handler = async (event) => {
  if (typeof event?.date === "string") return [await indexAndStore(event.date, { force: event.force === true })];
  // The schedule: AeroDataBox answers for 364 days back, so the days a little older than that are
  // the ones about to be asked of the archive. A week's window catches a run that failed.
  const results = [];
  for (let back = 369; back >= 362 && results.length < 2; back--) {
    const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
    if (!(await indexed(day))) results.push(await indexAndStore(day, {}));
  }
  return results;
};

async function indexAndStore(day, { force }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < HISTORY_START) return { day, skipped: "outside the archive" };
  if (!force && (await indexed(day))) return { day, skipped: "already indexed" };
  const started = Date.now();
  const parts = await releaseParts(day);
  if (!parts.length) {
    await put(`${PREFIX}/${day}/_day.json`, JSON.stringify({ day, missing: true }), false);
    return { day, missing: true };
  }
  const { manifest, airlines } = await indexDay(concatenated(parts), day, tables);
  const entries = [...airlines.entries()];
  for (let i = 0; i < entries.length; i += 32) {
    await Promise.all(entries.slice(i, i + 32).map(([airline, rows]) => put(`${PREFIX}/${day}/${airline}.json.gz`, JSON.stringify(rows), true)));
  }
  await put(`${PREFIX}/${day}/_day.json`, JSON.stringify({ ...manifest, parts: parts.length }), false);
  const result = { ...manifest, seconds: Math.round((Date.now() - started) / 1000) };
  console.log(JSON.stringify({ event: "indexed", ...result }));
  return result;
}

/**
 * The day's release files, in order: `v2024.05.15-planes-readsb-prod-0.tar.aa`, `.ab`, … or one
 * `.tar`. Found by asking for them, not through GitHub's API, whose unauthenticated limit is sixty
 * an hour. `staging` when there is no `prod`.
 */
export async function releaseParts(day, fetcher = fetch) {
  const year = day.slice(0, 4);
  for (const kind of ["prod", "staging"]) {
    const tag = `v${day.replaceAll("-", ".")}-planes-readsb-${kind}-0`;
    const base = `https://github.com/adsblol/globe_history_${year}/releases/download/${tag}/${tag}.tar`;
    const parts = [];
    for (const suffix of ["aa", "ab", "ac", "ad", "ae", "af"]) {
      if (!(await exists(`${base}.${suffix}`, fetcher))) break;
      parts.push(`${base}.${suffix}`);
    }
    if (parts.length) return parts;
    if (await exists(base, fetcher)) return [base];
  }
  return [];
}

async function exists(url, fetcher) {
  const response = await fetcher(url, { method: "HEAD", redirect: "follow" });
  return response.ok;
}

/** The parts as one stream of bytes, fetched one after another. */
async function* concatenated(urls) {
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    for await (const chunk of response.body) yield chunk;
  }
}

async function indexed(day) {
  if (!BUCKET) return false;
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await (await client()).send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${day}/_day.json` }));
    return true;
  } catch {
    return false;
  }
}

let localOut = null;
async function put(key, text, gzip) {
  const body = gzip ? gzipSync(text) : Buffer.from(text);
  if (localOut) {
    const path = join(localOut, key);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await client()).send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: body, ContentType: "application/json",
  }));
}

// `node indexer.mjs 2024-05-15 --out <dir>`: one day, written to a folder rather than the bucket.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [day, flag, dir] = process.argv.slice(2);
  if (flag === "--out" && dir) localOut = dir;
  else if (!BUCKET) throw new Error("usage: node indexer.mjs <day> --out <dir>, or set HISTORY_BUCKET");
  console.log(JSON.stringify(await indexAndStore(day, { force: true })));
}
