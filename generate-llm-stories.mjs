import fs from 'node:fs';

// ⚠️ Берем ключи из .env
const API_KEY = process.env.YANDEX_API_KEY;
const FOLDER_ID = process.env.YANDEX_FOLDER_ID;

// ВАЖНО: Для креативных текстов лучше использовать Pro-версию (она умнее). 
// Если жаба душит (она чуть дороже), оставь 'yandexgpt-lite/latest'. 
// Но с Pro результат будет на голову выше.
const MODEL = 'yandexgpt/latest'; 
const LIMIT = 500; 

if (!API_KEY || !FOLDER_ID) {
  console.error('Ошибка: Не найдены YANDEX_API_KEY или YANDEX_FOLDER_ID в файле .env');
  process.exit(1);
}

const API_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

const geo = JSON.parse(fs.readFileSync('./public/data/historic.geojson', 'utf-8'));
const wp = JSON.parse(fs.readFileSync('./public/data/wikipedia.json', 'utf-8'));

// Загружаем то, что уже сгенерировали ранее, чтобы не платить дважды
const existingStories = fs.existsSync('./public/data/llm-stories.json')
  ? JSON.parse(fs.readFileSync('./public/data/llm-stories.json', 'utf-8'))
  : {};

const stories = { ...existingStories };

async function generateStory(props) {
  const facts = [];
  if (props.name) facts.push(`Название: ${props.name}`);
  if (props['addr:street']) facts.push(`Адрес: ${props['addr:street']}, ${props['addr:housenumber'] || ''}`);
  if (props['building:architecture']) facts.push(`Стиль: ${props['building:architecture']}`);
  if (props['year_of_construction'] || props.start_date) facts.push(`Год: ${props['year_of_construction'] || props.start_date}`);
  if (props['memorial:subject']) facts.push(`Посвящен: ${props['memorial:subject']}`);
  if (props.inscription) facts.push(`Надпись: ${props.inscription}`);
  if (props.description) facts.push(`Кратко: ${props.description}`);

  // Ищем текст в Википедии
  let wikiText = '';
  const wpTag = props.wikipedia;
  if (wpTag) {
    const title = wpTag.split(':')[1]?.split('#')[0].trim();
    if (title && wp[title]?.extract) {
      wikiText = wp[title].extract;
    }
  }

  // Новый, "живой" системный промпт
  const systemPrompt = `Ты — талантливый экскурсовод и краевед. Твоя задача — написать короткий (3-4 предложения), атмосферный и захватывающий рассказ об объекте для аудиогида. 
Твой текст будут слушать люди, которые стоят прямо перед этим зданием или памятником. 
Правила:
1. Не используй сухие энциклопедические фразы. Пиши так, будто рассказываешь другу.
2. Начни с интригующего факта или яркой детали.
3. Если фактов мало — опиши архитектуру, стиль, или атмосферу места.
4. НЕ ВЫДУМЫВАЙ имена и даты, которых нет в фактах. Но можешь использовать общие исторические контексты эпохи.
5. Текст должен звучать красиво вслух (без сложных конструкций).`;

  let userPrompt = `Факты об объекте:\n${facts.join('\n')}\n`;
  if (wikiText) {
    userPrompt += `\nТекст из Википедии (используй его, но перепиши более живым языком):\n${wikiText}`;
  } else {
    userPrompt += `\n(Текста из Википедии нет, придется импровизировать на основе фактов выше).`;
  }

  const body = {
    modelUri: `gpt://${FOLDER_ID}/${MODEL}`,
    completionOptions: { stream: false, temperature: 0.8, maxTokens: '300' },
    messages: [
      { role: 'system', text: systemPrompt },
      { role: 'user', text: userPrompt },
    ],
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Api-Key ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('Ошибка API:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
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
    
    // Пропускаем, если уже есть текст
    if (stories[f.id]) continue;

    // Пропускаем "пустышки" (где нет вообще ничего, даже адреса)
    if (!props.name && !props['building:architecture'] && !props['memorial:subject'] && !props['addr:street']) {
      continue;
    }

    console.log(`[${count + 1}] Генерируем: ${props.name || props['addr:street'] || props['@id']}...`);
    
    const story = await generateStory(props);
    if (story) {
      stories[f.id] = story;
      console.log(`   ✓ ${story.slice(0, 60)}...`);
      // Сохраняем после каждой генерации, чтобы не потерять при сбое
      fs.writeFileSync('./public/data/llm-stories.json', JSON.stringify(stories, null, 2), 'utf-8');
    }

    count++;
    await new Promise(r => setTimeout(r, 1200)); // Пауза
  }

  console.log(`\nГотово! Всего в базе ${Object.keys(stories).length} историй.`);
}

main();