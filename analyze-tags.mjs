import fs from 'node:fs';

const data = JSON.parse(
  fs.readFileSync('./public/data/historic.geojson', 'utf-8')
);

const stats = {
  total: data.features.length,
  hasName: 0,
  hasWikidata: 0,
  hasWikipedia: 0,
  hasArchitecture: 0,
  hasYear: 0,
  hasArchitect: 0,
  hasRef: 0,
  onlyAddr: 0, // только адрес, больше ничего
};

const tagCounts = {};

for (const f of data.features) {
  const p = f.properties;
  if (p.name || p['name:ru']) stats.hasName++;
  if (p.wikidata) stats.hasWikidata++;
  if (p.wikipedia) stats.hasWikipedia++;
  if (p['building:architecture']) stats.hasArchitecture++;
  if (p['year_of_construction'] || p.start_date) stats.hasYear++;
  if (p.architect || p['architect:wikidata']) stats.hasArchitect++;
  if (p.ref || p['ref:ru']) stats.hasRef++;

  // Считаем все теги
  for (const key of Object.keys(p)) {
    tagCounts[key] = (tagCounts[key] || 0) + 1;
  }

  const interesting = ['name', 'name:ru', 'wikidata', 'wikipedia',
    'building:architecture', 'year_of_construction', 'start_date',
    'architect', 'architect:wikidata', 'heritage', 'ref'];
  if (!interesting.some((k) => p[k])) stats.onlyAddr++;
}

console.log('Всего:', stats.total);
console.log('---');
console.log('С именем:', stats.hasName);
console.log('С wikidata:', stats.hasWikidata);
console.log('С wikipedia:', stats.hasWikipedia);
console.log('С архитектурой:', stats.hasArchitecture);
console.log('С годом:', stats.hasYear);
console.log('С архитектором:', stats.hasArchitect);
console.log('С ref (реестр):', stats.hasRef);
console.log('Только адрес, без инфы:', stats.onlyAddr);
console.log('---');
console.log('Топ-30 тегов:');
Object.entries(tagCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .forEach(([k, v]) => console.log(`  ${k}: ${v}`));