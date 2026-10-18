import fs from 'node:fs';

// Берем ключи из переменных окружения
const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const MODEL = 'yandexgpt-lite/latest';
const LIMIT = 500; // Поставил 500, раз ты уже готов генерить всё

if (!API_KEY || !FOLDER_ID) {
  console.error('Ошибка: Не найдены YANDEX_API_KEY или YANDEX_FOLDER_ID в файле .env');
  process.exit(1);
}

const API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// Загружаем данные
const geo = JSON.parse(fs.readFileSync('./public/data/historic.geojson', 'utf-8'));
const wp = JSON.parse(fs.readFileSync('./public/data/wikipedia.json', 'utf-8'));

const stories = {};

async function generateStory(props) {
  const facts = [];
  if (props.name) facts.push(`Название: ${props.name}`);
  if (props['addr:street']) facts.push(`Адрес: ${props['addr:street']}, ${props['addr:housenumber'] || ''}`);
  if (props['building:architecture']) facts.push(`Архитектурный стиль: ${props['building:architecture']}`);
  if (props['year_of_construction'] || props.start_date) facts.push(`Год: ${props['year_of_construction'] || props.start_date}`);
  if (props['building:levels']) facts.push(`Этажей: ${props['building:levels']}`);
  if (props['memorial:subject']) facts.push(`Мемориал посвящен: ${props['memorial:subject']}`);
  if (props.inscription) facts.push(`Надпись на табличке: ${props.inscription}`);
  if (props.description) facts.push(`Описание из OSM: ${props.description}`);

  const systemPrompt = `Ты — краевед и экскурсовод по Нижнему Новгороду. Напиши короткий (2-3 предложения), увлекательный и живой рассказ об объекте. Используй ТОЛЬКО факты из списка ниже. Не выдумывай имена, даты или события, которых нет в фактах. Если фактов мало, просто опиши здание или памятник на основе его стиля и назначения.`;

  const userPrompt = `Факты:\n${facts.join('\n')}`;

  const body = {
    modelUri: `gpt://${FOLDER_ID}/${MODEL}`,
    completionOptions: {
      stream: false,
      temperature: 0.7,
      maxTokens: '200',
    },
    messages: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: userPrompt },
    ],
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('Ошибка API:', res.status, await res.text());
      return null;
    }

        const data = await res.json();
    // Правильный путь к тексту ответа YandexGPT
    return data.result?.alternatives?.[0]?.message?.text?.trim() || null;
  } catch (err) {
    console.error('Ошибка сети:', err.message);
    return null;
  }
}

async function main() {
  let count = 0;

  for (const f of geo.features) {
    if (count >= LIMIT) break;

    const props = f.properties;

    // Пропускаем, если уже есть хорошее описание в Википедии
    const wpTag = props.wikipedia;
    if (wpTag) {
      const title = wpTag.split(':')[1]?.split('#')[0].trim();
      if (title && wp[title]?.extract && wp[title].extract.length > 100) {
        continue;
      }
    }

    // Пропускаем, если нет вообще никаких зацепок для рассказа
    if (!props.name && !props['building:architecture'] && !props['memorial:subject']) {
      continue;
    }

    console.log(`[${count + 1}/${LIMIT}] Генерируем: ${props.name || props['addr:street'] || props['@id']}...`);

    const story = await generateStory(props);
    if (story) {
      stories[f.id] = story;
      console.log(`   ✓ ${story.slice(0, 60)}...`);
    }

    count++;
    // Пауза, чтобы не превысить лимиты (YandexGPT считает токены, но лимиты по RPM есть)
    await new Promise(r => setTimeout(r, 1000));
  }

  fs.writeFileSync(
    './public/data/llm-stories.json',
    JSON.stringify(stories, null, 2),
    'utf-8'
  );

  console.log(`\nГотово! Сгенерировано ${Object.keys(stories).length} историй.`);
  console.log('Файл: public/data/llm-stories.json');
}

main();