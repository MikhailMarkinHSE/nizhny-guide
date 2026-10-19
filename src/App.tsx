import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

setWorkerUrl(workerUrl);

type WikidataEntry = {
  label?: string;
  inception?: string;
  architect?: string;
  style?: string;
  image?: string;
  article?: string;
};

type WikipediaEntry = {
  extract: string;
  thumbnail: string | null;
  url: string | null;
};

type NearbyItem = {
  props: Record<string, string>;
  coords: [number, number];
  distance: number;
};

function extractQId(url: string): string | null {
  const m = url.match(/Q\d+$/);
  return m ? m[0] : null;
}

function formatYear(date: string): string {
  const m = date.match(/^(-?\d{1,4})/);
  return m ? m[1] : date;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(1)} км`;
}

function getObjectType(props: Record<string, string>): 'building' | 'memorial' | 'other' {
  if (props.memorial || props['memorial:subject'] || props['memorial:type']) {
    return 'memorial';
  }
  if (props.building || props['building:architecture'] || props['building:levels']) {
    return 'building';
  }
  return 'other';
}

// ---- Очистка текста для TTS ----
function cleanTextForSpeech(text: string): string {
  let s = text;
  s = s.replace(/[*_#`~]/g, '');
  s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/\bул\.\s*/g, 'улица ');
  s = s.replace(/\bд\.\s*/g, 'дом ');
  s = s.replace(/\bгг\.\s*/g, 'годы ');
  s = s.replace(/\bг\.\s*(?=\d)/g, 'года ');
  s = s.replace(/\bг\.\s*/g, 'город ');
  s = s.replace(/\bвв\.\s*/g, 'века ');
  s = s.replace(/\bв\.\s*/g, 'век ');
  s = s.replace(/\bпр\.\s*/g, 'проспект ');
  s = s.replace(/\bпл\.\s*/g, 'площадь ');
  s = s.replace(/\bнаб\.\s*/g, 'набережная ');
  s = s.replace(/\bпер\.\s*/g, 'переулок ');
  s = s.replace(/\bш\.\s*/g, 'шоссе ');
  s = s.replace(/\bт\.\s*е\.\s*/g, 'то есть ');
  s = s.replace(/\bт\.\s*д\.\s*/g, 'так далее ');
  s = s.replace(/\bт\.\s*п\.\s*/g, 'тому подобное ');
  s = s.replace(/[|/\\<>]/g, ' ');
  s = s.replace(/[–—]/g, ', ');
  s = s.replace(/\s+/g, ' ').replace(/\.{2,}/g, '.');
  s = s.trim();
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}

function speakText(text: string) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const cleanText = cleanTextForSpeech(text);
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'ru-RU';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const preferred = ['Milena', 'Microsoft Irina', 'Google русский', 'Yuri', 'Katya'];
  let ruVoice: SpeechSynthesisVoice | undefined;
  for (const name of preferred) {
    ruVoice = voices.find(v => v.name.includes(name));
    if (ruVoice) break;
  }
  if (!ruVoice) ruVoice = voices.find(v => v.lang === 'ru-RU' || v.lang.startsWith('ru'));
  if (ruVoice) utterance.voice = ruVoice;

  setTimeout(() => window.speechSynthesis.speak(utterance), 100);
}

(window as any).stopSpeech = () => {
  window.speechSynthesis.cancel();
};

// ---- Фолбэк-рассказ, если нет текста ----
function generateFallbackStory(props: Record<string, string>, type: string): string {
  const bits: string[] = [];
  if (type === 'building') {
    if (props['building:architecture']) bits.push(`в стиле ${props['building:architecture']}`);
    const year = props['year_of_construction'] || props.start_date;
    if (year) bits.push(`${formatYear(year)} года`);
    if (bits.length) return `Здание ${bits.join(', ')}.`;
  }
  if (type === 'memorial' && props['memorial:subject']) {
    return `Памятник, посвящённый ${props['memorial:subject']}.`;
  }
  return 'Историческое место в Нижнем Новгороде.';
}

// ---- НОВЫЙ попап ----
function buildPopupHTML(
  props: Record<string, string>,
  wd: WikidataEntry | undefined,
  wp: WikipediaEntry | undefined,
  story: string | undefined
): { html: string; text: string } {
  const type = getObjectType(props);

  const title =
    wd?.label ||
    props.name ||
    props['name:ru'] ||
    `${props['addr:street'] || ''} ${props['addr:housenumber'] || ''}`.trim() ||
    (type === 'memorial' ? 'Мемориал' : 'Историческое место');

  // Основной рассказ (по приоритету)
  let mainStory = '';
  if (wp?.extract) {
    mainStory = wp.extract.length > 500
      ? wp.extract.slice(0, 500).trim() + '…'
      : wp.extract;
  } else if (story) {
    mainStory = story;
  } else if (props.description) {
    mainStory = props.description;
  } else if (props.inscription) {
    mainStory = `«${props.inscription}»`;
  } else {
    mainStory = generateFallbackStory(props, type);
  }

  // Текст для озвучки: заголовок + рассказ
  const spokenText = `${title}. ${mainStory}`;

  // ---- Сухие факты (в раскрывающемся блоке) ----
  const facts: string[] = [];

  if (type === 'building') {
    const year = wd?.inception || props['year_of_construction'] || props.start_date;
    if (year) facts.push(`<div class="fact"><span class="fact-label">Год</span><span class="fact-value">${formatYear(year)}</span></div>`);

    const architect = wd?.architect || props.architect;
    if (architect) facts.push(`<div class="fact"><span class="fact-label">Архитектор</span><span class="fact-value">${architect}</span></div>`);

    const style = wd?.style || props['building:architecture'];
    if (style) facts.push(`<div class="fact"><span class="fact-label">Стиль</span><span class="fact-value">${style}</span></div>`);

    if (props['building:levels']) facts.push(`<div class="fact"><span class="fact-label">Этажей</span><span class="fact-value">${props['building:levels']}</span></div>`);
  }

  if (type === 'memorial' && props['memorial:subject']) {
    facts.push(`<div class="fact"><span class="fact-label">Посвящён</span><span class="fact-value">${props['memorial:subject']}</span></div>`);
  }

  if (props['addr:street']) {
    facts.push(`<div class="fact"><span class="fact-label">Адрес</span><span class="fact-value">${props['addr:street']}, ${props['addr:housenumber'] || ''}</span></div>`);
  }

  if (props['heritage:name'] || props.heritage) {
    facts.push(`<div class="fact"><span class="fact-label">Наследие</span><span class="fact-value">${props['heritage:name'] || props.heritage}</span></div>`);
  }

  const img = wd?.image || wp?.thumbnail;

  const links: string[] = [];
  if (wd?.article) links.push(`<a href="${wd.article}" target="_blank" rel="noopener">Википедия →</a>`);
  else if (wp?.url) links.push(`<a href="${wp.url}" target="_blank" rel="noopener">Читать полностью →</a>`);

  const hasDetails = facts.length > 0 || img || links.length > 0;

  const html = `
    <div class="popup">
      <div class="popup-header">
        <h3 class="popup-title">${title}</h3>
        <button onclick="window.stopSpeech()" class="popup-stop" title="Остановить">⏹</button>
      </div>
      <p class="popup-story">${mainStory}</p>
      ${hasDetails ? `
        <details class="popup-details">
          <summary>Подробнее</summary>
          <div class="popup-facts">
            ${img ? `<img class="popup-image" src="${img}" alt="" />` : ''}
            ${facts.join('')}
            ${links.length ? `<div class="popup-links">${links.join(' · ')}</div>` : ''}
          </div>
        </details>
      ` : ''}
      <div class="spoken-text" style="display:none;">${spokenText}</div>
    </div>
  `;

  return { html, text: spokenText };
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [nearby, setNearby] = useState<NearbyItem[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => {
    return !localStorage.getItem('gvidon-visited');
  });
  const featuresRef = useRef<any[]>([]);
  const hasAutoOpenedSheet = useRef(false);

  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    const unlockAudio = () => {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance('');
        window.speechSynthesis.speak(u);
      }
      document.removeEventListener('touchstart', unlockAudio);
      document.removeEventListener('click', unlockAudio);
    };
    document.addEventListener('touchstart', unlockAudio);
    document.addEventListener('click', unlockAudio);

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [44.0059, 56.3269],
      zoom: 14,
    });

    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      },
      trackUserLocation: false,
      showAccuracyCircle: false,
    });

    map.current.addControl(geolocate, 'top-right');

    const closeSheet = () => setSheetOpen(false);
    map.current.on('dragstart', closeSheet);
    map.current.on('click', closeSheet);
    mapContainer.current.addEventListener('touchstart', closeSheet);

    map.current.on('load', async () => {
      const mapInstance = map.current!;

      try {
        const [osmRes, wdRes, wpRes, llmRes] = await Promise.all([
          fetch('/data/historic.geojson').then((r) => r.json()),
          fetch('/data/wikidata.json').then((r) => r.json()),
          fetch('/data/wikipedia.json').then((r) => r.json()),
          fetch('/data/llm-stories.json').then((r) => r.json()),
        ]);

        const storiesMap = llmRes as Record<string, string>;
        const wikidataMap = new Map<string, WikidataEntry>();

        for (const b of wdRes.results.bindings) {
          const val = (v: any): string | undefined =>
            typeof v === 'string' ? v : v?.value;

          const itemUrl = val(b.item);
          const qid = itemUrl ? extractQId(itemUrl) : null;
          if (!qid) continue;

          const existing = wikidataMap.get(qid) || {};

          const label = val(b.itemLabel);
          if (label && !existing.label) existing.label = label;

          const inception = val(b.inception);
          if (inception && !existing.inception)
            existing.inception = formatYear(inception);

          const architect = val(b.architectLabel);
          if (architect) {
            existing.architect = existing.architect
              ? `${existing.architect}, ${architect}`
              : architect;
          }

          const style = val(b.architecturalStyleLabel);
          if (style && !existing.style) existing.style = style;

          const image = val(b.image);
          if (image && !existing.image) existing.image = image;

          const article = val(b.article);
          if (article && !existing.article) existing.article = article;

          wikidataMap.set(qid, existing);
        }

        const normalize = (s: string): string =>
          s
            .toLowerCase()
            .replace(/\s*\(.*?\)\s*/g, '')
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();

        const wikipediaMap = new Map<string, WikipediaEntry>();
        for (const [title, entry] of Object.entries(
          wpRes as Record<string, WikipediaEntry>
        )) {
          wikipediaMap.set(normalize(title), entry);
          wikipediaMap.set(title, entry);
        }

        const findWikipedia = (
          tag: string | undefined
        ): WikipediaEntry | undefined => {
          if (!tag) return undefined;
          const [lang, ...rest] = tag.split(':');
          if (!lang) return undefined;
          const title = rest.join(':').split('#')[0].trim();
          if (!title) return undefined;
          return (
            wikipediaMap.get(title) || wikipediaMap.get(normalize(title)) || undefined
          );
        };

        const filtered = {
          type: 'FeatureCollection' as const,
          features: osmRes.features,
        };

        featuresRef.current = filtered.features;

        mapInstance.addSource('historic', {
          type: 'geojson',
          data: filtered,
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 15,
        });

        mapInstance.addLayer({
          id: 'clusters',
          type: 'circle',
          source: 'historic',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': [
              'step',
              ['get', 'point_count'],
              '#e63946',
              10,
              '#f77f00',
              30,
              '#d62828',
            ],
            'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 30, 28],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        });

        mapInstance.addLayer({
          id: 'cluster-count',
          type: 'symbol',
          source: 'historic',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-size': 12,
          },
          paint: { 'text-color': '#fff' },
        });

        mapInstance.addLayer({
          id: 'unclustered-point',
          type: 'circle',
          source: 'historic',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': [
              'case',
              ['has', 'memorial'],
              '#3a86ff',
              '#e63946',
            ],
            'circle-radius': 6,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff',
          },
        });

        const showPopup = (
          props: Record<string, string>,
          coords: [number, number]
        ) => {
          const qid = props.wikidata;
          const wd = qid ? wikidataMap.get(qid) : undefined;
          const wp = findWikipedia(props.wikipedia);
          const id = props['@id'] || (props as any).id;
          const story = id ? storiesMap[id] : undefined;

          const { html, text } = buildPopupHTML(props, wd, wp, story);

          const popup = new maplibregl.Popup({ maxWidth: '340px' })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(mapInstance);

          speakText(text);

          popup.on('close', () => {
            (window as any).stopSpeech();
          });
        };

        (mapInstance as any)._showPopup = showPopup;

        mapInstance.on('click', 'clusters', (e) => {
          const features = mapInstance.queryRenderedFeatures(e.point, {
            layers: ['clusters'],
          });
          const feature = features[0];
          if (!feature) return;
          const clusterId = feature.properties?.cluster_id;
          const source = mapInstance.getSource('historic') as maplibregl.GeoJSONSource;
          source.getClusterExpansionZoom(clusterId).then((zoom) => {
            const coords = (feature.geometry as any).coordinates;
            mapInstance.easeTo({ center: coords, zoom });
          });
        });

        mapInstance.on('click', 'unclustered-point', (e) => {
          const feature = e.features?.[0];
          if (!feature) return;
          const props = feature.properties;
          if (!props) return;
          const coords = (feature.geometry as any).coordinates.slice() as [
            number,
            number
          ];
          showPopup(props, coords);
        });

        for (const layer of ['clusters', 'unclustered-point']) {
          mapInstance.on('mouseenter', layer, () => {
            mapInstance.getCanvas().style.cursor = 'pointer';
          });
          mapInstance.on('mouseleave', layer, () => {
            mapInstance.getCanvas().style.cursor = '';
          });
        }

        geolocate.on('geolocate', (e: any) => {
          const lng = e.coords.longitude;
          const lat = e.coords.latitude;
          setUserPos([lng, lat]);

          const withDist: NearbyItem[] = featuresRef.current
            .map((f: any) => ({
              props: f.properties,
              coords: f.geometry.coordinates as [number, number],
              distance: haversine(
                lat,
                lng,
                f.geometry.coordinates[1],
                f.geometry.coordinates[0]
              ),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 10);

          setNearby(withDist);

          if (!hasAutoOpenedSheet.current) {
            setSheetOpen(true);
            hasAutoOpenedSheet.current = true;
          }
        });
      } catch (err) {
        console.error('Ошибка загрузки данных:', err);
      }
    });

    return () => {
      if (mapContainer.current) {
        mapContainer.current.removeEventListener('touchstart', closeSheet);
      }
    };
  }, []);

  const handleNearbyClick = (item: NearbyItem) => {
    if (!map.current) return;
    map.current.flyTo({ center: item.coords, zoom: 17, duration: 1000 });
    const showPopup = (map.current as any)._showPopup;
    if (showPopup) {
      setTimeout(() => showPopup(item.props, item.coords), 1100);
    }
    setSheetOpen(false);
  };

  const sidebarContent = (
    <>
      {!userPos && (
        <p className="hint">
          Нажми кнопку <b>«Где я»</b> на карте — покажу, что интересного рядом.
        </p>
      )}
      {userPos && nearby.length === 0 && (
        <p className="hint">
          Рядом ничего не нашлось. Попробуй переместиться ближе к центру.
        </p>
      )}
      {nearby.length > 0 && (
        <>
          <h2>Рядом с тобой</h2>
          <ul className="nearby-list">
            {nearby.map((item, i) => {
              const title =
                item.props.name ||
                item.props['name:ru'] ||
                `${item.props['addr:street'] || ''} ${item.props['addr:housenumber'] || ''}`.trim() ||
                'Историческое место';
              const type = getObjectType(item.props);
              const isMemorial = type === 'memorial';
              return (
                <li
                  key={i}
                  onClick={() => handleNearbyClick(item)}
                  className={isMemorial ? 'is-memorial' : ''}
                >
                  <div className="nearby-title">{title}</div>
                  <div className="nearby-distance">
                    {isMemorial ? '🕯 ' : '🏛 '}
                    {formatDistance(item.distance)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );

  return (
    <div className="app">
      <header className="header">
        <button className="header-menu" onClick={() => setMenuOpen(true)} aria-label="Меню">
          ☰
        </button>
        <div className="header-brand">
  <img src="/icon-192.png" alt="" className="header-logo" />
  <h1>Гвидон</h1>
</div>
        <div className="header-spacer" />
      </header>

      <div className="content">
        <aside className="sidebar">{sidebarContent}</aside>
        <div ref={mapContainer} className="map" />
      </div>

      <div className={`sheet ${sheetOpen ? 'sheet-open' : ''}`}>
        <button
          className="sheet-handle"
          onClick={() => setSheetOpen((v) => !v)}
          aria-label="Открыть список ближайших"
        >
          {sheetOpen ? '▼' : '▲'} Рядом с тобой
        </button>
        <div className="sheet-content">{sidebarContent}</div>
      </div>

      {/* Меню */}
      {menuOpen && (
        <div className="menu-overlay" onClick={() => setMenuOpen(false)}>
          <div className="menu-panel" onClick={(e) => e.stopPropagation()}>
            <button className="menu-close" onClick={() => setMenuOpen(false)}>×</button>
            <h2 className="menu-title">Меню</h2>
            <button
              className="menu-item"
              onClick={() => {
                setMenuOpen(false);
                setShowWelcome(true);
              }}
            >
              О приложении
            </button>
            <button
              className="menu-item"
              onClick={() => {
                if (confirm('Сбросить кэш? Приложение перезагрузится.')) {
                  localStorage.clear();
                  if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.getRegistrations().then((rs) => {
                      rs.forEach((r) => r.unregister());
                    });
                  }
                  setTimeout(() => window.location.reload(), 300);
                }
              }}
            >
              Сбросить кэш
            </button>
          </div>
        </div>
      )}

      {/* Welcome / Заставка */}
      {showWelcome && (
        <div className="welcome">
          <div className="welcome-content">
            <img src="/icon-192.png" alt="Гвидон" className="welcome-logo-img" />
            <h1 className="welcome-title">Гвидон</h1>
            <p className="welcome-tagline">Guide on</p>
            <p className="welcome-hint">
              Твой личный гид по Нижнему Новгороду.
              <br />
              Гуляй по городу — приложение расскажет о зданиях и памятниках рядом.
            </p>
            <button
              className="welcome-btn"
              onClick={() => {
                localStorage.setItem('gvidon-visited', '1');
                setShowWelcome(false);
              }}
            >
              Начать прогулку
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;