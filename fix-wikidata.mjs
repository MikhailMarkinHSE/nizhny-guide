import fs from 'node:fs';

const raw = fs.readFileSync('./public/data/wikidata.json', 'utf-8');

// Пытаемся как обычный JSON
let data;
try {
  data = JSON.parse(raw);
} catch {
  // Если не получилось — парсим как JSONL (по строкам)
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  data = lines.map((l) => JSON.parse(l));
}

// Если получился массив — оборачиваем в структуру Wikidata
if (Array.isArray(data)) {
  data = { results: { bindings: data } };
}

// Если объекта с bindings нет — создаём
if (!data.results) data.results = {};
if (!Array.isArray(data.results.bindings)) data.results.bindings = [];

fs.writeFileSync(
  './public/data/wikidata.json',
  JSON.stringify(data, null, 2),
  'utf-8'
);

console.log(`Готово. Записей: ${data.results.bindings.length}`);