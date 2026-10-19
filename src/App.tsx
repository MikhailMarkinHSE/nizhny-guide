import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

// Функция для озвучки текста (голосовой Гвидон)
function speakText(text: string) {
  if (!('speechSynthesis' in window)) return;

  // Останавливаем предыдущую озвучку, если она шла
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU'; // Русский язык
  utterance.rate = 1.0;     // Скорость (1.0 - нормальная)
  utterance.pitch = 1.0;    // Тон
  
  window.speechSynthesis.speak(utterance);
}

// Глобальная функция для остановки (нужна для кнопки в попапе)
(window as any).stopSpeech = () => {
  window.speechSynthesis.cancel();
};

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

function buildPopupHTML(
  props: Record<string, string>,
  wd: WikidataEntry | undefined,
  wp: WikipediaEntry | undefined,
  story: string | undefined
): string {
  const type = getObjectType(props);

  const title =
    wd?.label ||
    props.name ||
    props['name:ru'] ||
    `${props['addr:street'] || ''} ${props['addr:housenumber'] || ''}`.trim() ||
    (type === 'memorial' ? 'Мемориал' : 'Историческое место');

  // Собираем чистый текст для голосового Гвидона
  let spokenText = `${title}. `;

  const parts: string[] = [
    `<h3>${title}</h3>`,
    // Кнопка остановки
    `<button onclick="window.stopSpeech()" style="position: absolute; top: 8px; right: 8px; background: #f0f0f0; border: none; border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;">⏹ Стоп</button>`
  ];

  // 1. Приоритет: Википедия
  if (wp?.extract) {
    const short = wp.extract.length > 500 ? wp.extract.slice(0, 500).trim() + '…' : wp.extract;
    parts.push(`<p style="color: #333; line-height: 1.5; margin: 8px 0; padding-right: 40px;">${short}</p>`);
    spokenText += short + ' ';
  } 
  // 2. Если нет Википедии, но есть LLM-история
  else if (story) {
    parts.push(`<p style="color: #333; line-height: 1.5; margin: 8px 0; padding-right: 40px;">${story}</p>`);
    spokenText += story + ' ';
  }

  if (type === 'memorial') {
    if (props['memorial:subject']) {
      parts.push(`<p><b>Посвящён:</b> ${props['memorial:subject']}</p>`);
      spokenText += `Посвящён: ${props['memorial:subject']}. `;
    }
    if (props.inscription && !wp?.extract && !story) {
      parts.push(`<blockquote style="margin: 8px 0; padding: 6px 10px; border-left: 3px solid #e63946; background: #fafafa; font-style: italic; color: #444;">${props.inscription}</blockquote>`);
      spokenText += `Надпись на табличке: ${props.inscription}. `;
    }
  }

  if (type === 'building') {
    const year = wd?.inception || props['year_of_construction'] || props.start_date;
    if (year) {
      parts.push(`<p><b>Год:</b> ${formatYear(year)}</p>`);
      spokenText += `Год постройки: ${formatYear(year)}. `;
    }
    const style = wd?.style || props['building:architecture'];
    if (style) {
      parts.push(`<p><b>Стиль:</b> ${style}</p>`);
      spokenText += `Архитектурный стиль: ${style}. `;
    }
  }

  if (props['addr:street']) {
    parts.push(`<p><b>Адрес:</b> ${props['addr:street']}, ${props['addr:housenumber'] || ''}</p>`);
  }

  const img = wd?.image || wp?.thumbnail;
  if (img) {
    parts.push(`<img src="${img}" alt="" style="max-width: 260px; border-radius: 6px; margin-top: 6px;" />`);
  }

  // Скрытое поле, чтобы потом передать текст в озвучку
  parts.push(`<div class="spoken-text" style="display:none;">${spokenText}</div>`);

  return parts.join('');
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [nearby, setNearby] = useState<NearbyItem[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const featuresRef = useRef<any[]>([]);
  const hasAutoOpenedSheet = useRef(false);

  useEffect(() => {
    if (map.current || !mapContainer.current) return;

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
      trackUserLocation: true,
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
          
          const html = buildPopupHTML(props, wd, wp, story);
          
          const popup = new maplibregl.Popup({ maxWidth: '320px' })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(mapInstance);

          // --- МАГИЯ АУДИОГИДА ---
          // Ждем миллисекунду, пока попап отрисуется, и достаем из него текст
          setTimeout(() => {
            // Находим скрытый блок внутри попапа
            const popupEl = popup.getElement();
            const textEl = popupEl?.querySelector('.spoken-text');
            if (textEl && textEl.textContent) {
              speakText(textEl.textContent);
            }
          }, 100);

          // Останавливаем озвучку, если пользователь закрыл попап
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
        <h1>Гвидон</h1>
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
    </div>
  );
}

export default App;