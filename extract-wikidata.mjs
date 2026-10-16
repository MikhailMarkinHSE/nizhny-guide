import fs from 'node:fs';

const file = fs.readFileSync('./public/data/historic.geojson', 'utf-8');
const data = JSON.parse(file);

const ids = new Set();

for (const feature of data.features) {
  const id = feature.properties.wikidata;
  if (id) ids.add(id);
}

const list = [...ids].sort();
console.log(`Найдено уникальных ID: ${list.length}`);
console.log('');
console.log('Скопируй в SPARQL:');
console.log('');
console.log(list.map((id) => `wd:${id}`).join('\n'));