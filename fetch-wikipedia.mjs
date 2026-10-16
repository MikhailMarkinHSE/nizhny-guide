import fs from 'node:fs';

const input = JSON.parse(
  fs.readFileSync('./public/data/historic.geojson', 'utf-8')
);

// Собираем уникальные статьи по языкам
const articlesByLang = new Map(); // lang → Set<title>

for (const f of input.features) {
  const w = f.properties.wikipedia;
  if (!w) continue;

  const [lang, ...rest] = w.split(':');
  const title = rest.join(':').split('#')[0].trim();
  if (!lang || !title) continue;

  if (!articlesByLang.has(lang)) articlesByLang.set(lang, new Set());
  articlesByLang.get(lang).add(title);
}

const total = [...articlesByLang.values()].reduce((s, set) => s + set.size, 0);
console.log(`Найдено уникальных статей: ${total}`);

const result = {};

// Wikipedia API: до 50 статей за запрос
const BATCH_SIZE = 20; // осторожнее, URL должен быть < 2000 символов

for (const [lang, titlesSet] of articlesByLang) {
  const titles = [...titlesSet];

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      prop: 'extracts|pageimages|info',
      exintro: '1',
      explaintext: '1',
      inprop: 'url',
      pilimit: '1',
      pithumbsize: '400',
      titles: batch.join('|'),
      redirects: '1',
      origin: '*',
    });

    const url = `https://${lang}.wikipedia.org/w/api.php?${params}`;
    console.log(`\n→ Батч ${i / BATCH_SIZE + 1}: ${batch.length} статей`);

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'NizhnyGuide/0.1 (https://example.com; educational project)',
        },
      });

      if (!res.ok) {
        console.log(`✗ Ошибка ${res.status} для батча`);
        continue;
      }

      const data = await res.json();
      const pages = data.query?.pages || {};

      for (const page of Object.values(pages)) {
        if (!page.title || page.missing !== undefined) continue;

        const extract = page.extract || '';
        if (!extract) continue;

        result[page.title] = {
          extract,
          thumbnail: page.thumbnail?.source || null,
          url: page.fullurl || null,
        };

        console.log(`  ✓ ${page.title} (${extract.length} симв.)`);
      }
    } catch (err) {
      console.log(`✗ Батч упал:`, err.message);
    }

    // Пауза 1 секунда между батчами
    await new Promise((r) => setTimeout(r, 1000));
  }
}

fs.writeFileSync(
  './public/data/wikipedia.json',
  JSON.stringify(result, null, 2),
  'utf-8'
);

console.log(`\n═══ Готово. Сохранено: ${Object.keys(result).length} статей.`);