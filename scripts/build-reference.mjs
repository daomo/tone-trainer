import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const AUDIO_DIR = path.join(ROOT, "tmp", "audio");
const CSV_PATH = path.join(ROOT, "tmp", "chinese_sentences_full.csv");
const OUT_DIR = path.join(ROOT, "data", "reference");
const OUT_AUDIO_DIR = path.join(ROOT, "public", "audio");
const OUT_PUBLIC_REF_DIR = path.join(ROOT, "public", "reference");

const FILE_RE = /^(\d{4})_(.+?)__([FM])__(.+)\.mp3$/;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function buildIndexRows(csvRows) {
  const map = new Map();
  for (const row of csvRows) {
    const id = String(row.id ?? "").trim();
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

function normalizeId(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return id;
  return String(n).padStart(4, "0");
}

const csvText = await fs.readFile(CSV_PATH, "utf8");
const csvRows = parseCsv(csvText);
const csvIndex = buildIndexRows(csvRows);

const audioFiles = (await fs.readdir(AUDIO_DIR)).filter((f) => f.endsWith(".mp3"));
const items = new Map();
const warnings = [];

for (const filename of audioFiles) {
  const match = FILE_RE.exec(filename);
  if (!match) {
    warnings.push(`skip: ${filename}`);
    continue;
  }

  const id = match[1];
  const sentenceInName = match[2];
  const gender = match[3];
  const voice = match[4];

  const row = csvIndex.get(String(Number(id))) || csvIndex.get(id) || null;
  const text = row?.["中国語"] || sentenceInName;
  const pinyin = row?.["ピンイン"] || "";
  const ja = row?.["日本語訳"] || "";
  const grammarTag = row?.["文法タグ"] || "";
  const topicTag = row?.["トピックタグ"] || "";

  const key = normalizeId(id);
  if (!items.has(key)) {
    items.set(key, {
      id: Number(id),
      key,
      text,
      pinyin,
      ja,
      grammarTag,
      topicTag,
      audio: [],
    });
  }

  items.get(key).audio.push({
    id: `${key}-${gender}-${voice}`,
    gender,
    voice,
    path: `audio/${filename}`,
  });
}

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.mkdir(OUT_AUDIO_DIR, { recursive: true });
await fs.mkdir(OUT_PUBLIC_REF_DIR, { recursive: true });

for (const filename of audioFiles) {
  const src = path.join(AUDIO_DIR, filename);
  const dst = path.join(OUT_AUDIO_DIR, filename);
  await fs.copyFile(src, dst);
}

const index = {
  version: 1,
  generatedAt: new Date().toISOString(),
  count: items.size,
  items: Array.from(items.values()).sort((a, b) => a.id - b.id),
};

await fs.writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");
await fs.writeFile(path.join(OUT_PUBLIC_REF_DIR, "index.json"), JSON.stringify(index, null, 2), "utf8");

if (warnings.length > 0) {
  console.warn(warnings.join("\n"));
}

console.log(`index.json: ${items.size} items`);
