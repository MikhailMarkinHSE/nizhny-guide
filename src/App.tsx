import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

// Обязательно: регистрируем воркер до создания карты
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

// Определяем тип объекта: здание, мемориал или прочее
function getObjectType(props: Record<string, string>): 'building' | 'memorial' | 'other' {
  if (props.memorial || props['memorial:subject'] || props['memorial:type']) {
    return 'memorial';
  }
  if (props.building || props['building:architecture'] || props['building:levels']) {
    return 'building';
  }
  return 'other';
}

// Строим HTML для попапа
function buildPopupHTML(
  props: Record<string, string>,
  wd: WikidataEntry | undefined,
  wp: WikipediaEntry | undefined
): string {
  const type = getObjectType(props);

  const title =
    wd?.label ||
    props.name ||
    props['name:ru'] ||
    `${props['addr:street'] || ''} ${props['addr:housenumber'] || ''}`.trim() ||
    (type === 'memorial' ? 'Мемориал' : 'Историческое место');

  const parts: string[] = [`<h3>${title}</h3>`];

  // ===== АННОТАЦИЯ ИЗ ВИКИПЕДИИ (в самом верху — это главное) =====
  if (wp?.extract) {
    const short =
      wp.extract.length > 500
        ? wp.extract.slice(0, 500).trim() + '…'
        : wp.extract;
    parts.push(
      `<p style="color: #333; line-height: 1.5; margin: 8px 0;">${short}</p>`
    );
  }

  // ===== МЕМОРИАЛ =====
  if (type === 'memorial') {
    if (props['memorial:subject']) {
      parts.push(`<p><b>Посвящён:</b> ${props['memorial:subject']}</p>`);
    }
    if (props['memorial:type']) {
      parts.push(`<p><b>Тип:</b> ${props['memorial:type']}</p>`);
    }
    if (props.inscription && !wp?.extract) {
      parts.push(
        `<blockquote style="margin: 8px 0; padding: 6px 10px; border-left: 3px solid #e63946; background: #fafafa; font-style: italic; color: #444;">${props.inscription}</blockquote>`
      );
    }
  }

  // ===== ЗДАНИЕ =====
  if (type === 'building') {
    const year =
      wd?.inception || props['year_of_construction'] || props.start_date;
    if (year) parts.push(`<p><b>Год:</b> ${formatYear(year)}</p>`);

    if (wd?.architect) parts.push(`<p><b>Архитектор:</b> ${wd.architect}</p>`);
    else if (props.architect) parts.push(`<p><b>Архитектор:</b> ${props.architect}</p>`);

    const style = wd?.style || props['building:architecture'];
    if (style) parts.push(`<p><b>Стиль:</b> ${style}</p>`);

    if (props['building:levels'])
      parts.push(`<p><b>Этажей:</b> ${props['building:levels']}</p>`);
    if (props['building:material'])
      parts.push(`<p><b>Материал:</b> ${props['building:material']}</p>`);
    else if (props.material)
      parts.push(`<p><b>Материал:</b> ${props.material}</p>`);
  }

  // ===== ОБЩЕЕ =====
  // Описание из OSM — только если нет аннотации из Википедии
  if (props.description && !wp?.extract) {
    parts.push(
      `<p style="color: #333; line-height: 1.45;">${props.description}</p>`
    );
  }

  if (props['heritage:name'] || props.heritage) {
    const h = props['heritage:name'] || props.heritage;
    parts.push(`<p><b>Объект наследия:</b> ${h}</p>`);
  }

  if (props['addr:street']) {
    parts.push(
      `<p><b>Адрес:</b> ${props['addr:street']}, ${props['addr:housenumber'] || ''}</p>`
    );
  }

  // Фото: Викисклад > Википедия thumbnail
  const img = wd?.image || wp?.thumbnail;
  if (img) {
    parts.push(
      `<img src="${img}" alt="" style="max-width: 260px; border-radius: 6px; margin-top: 6px;" />`
    );
  }

  // Ссылки
  const links: string[] = [];
  if (wd?.article) {
    links.push(
      `<a href="${wd.article}" target="_blank" rel="noopener">Википедия →</a>`
    );
  } else if (wp?.url) {
    links.push(
      `<a href="${wp.url}" target="_blank" rel="noopener">Читать полностью →</a>`
    );
  }

  if (links.length) {
    parts.push(`<p>${links.join(' · ')}</p>`);
  }

  if (props.source_ref) {
    parts.push(
      `<p style="font-size: 11px; color: #999; margin-top: 6px;">Источник: ${props.source_ref}</p>`
    );
  }

  return parts.join('');
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [nearby, setNearby] = useState<NearbyItem[]>([]);
  const [userPos, setUserPos] = useState<[number, number] | null>(null);
  const featuresRef = useRef<any[]>([]);

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

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');

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

    map.current.on('load', async () => {
      const mapInstance = map.current!;

      try {
        const [osmRes, wdRes, wpRes] = await Promise.all([
  fetch('/data/historic.geojson').then((r) => r.json()),
  fetch('/data/wikidata.json').then((r) => r.json()),
  fetch('/data/wikipedia.json').then((r) => r.json()),
]);

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

        // ===== Wikipedia: title → entry =====
// Нормализуем ключи: убираем "(Нижний Новгород)", пробелы, регистр, ё→е
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

const wikipediaMap = new Map<string, WikipediaEntry>();
for (const [title, entry] of Object.entries(wpRes as Record<string, WikipediaEntry>)) {
  wikipediaMap.set(normalize(title), entry);
  wikipediaMap.set(title, entry); // на случай точного совпадения
}

console.log(`Wikipedia: ${Object.keys(wpRes).length} статей`);

// Функция поиска аннотации по тегу OSM (например, "ru:Дом Рукавишниковых")
const findWikipedia = (tag: string | undefined): WikipediaEntry | undefined => {
  if (!tag) return undefined;
  const [lang, ...rest] = tag.split(':');
  if (!lang) return undefined;
  const title = rest.join(':').split('#')[0].trim();
  if (!title) return undefined;

  return (
    wikipediaMap.get(title) ||
    wikipediaMap.get(normalize(title)) ||
    undefined
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
            // Мемориалы — синие, здания — красные
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

        const showPopup = (props: Record<string, string>, coords: [number, number]) => {
  const qid = props.wikidata;
  const wd = qid ? wikidataMap.get(qid) : undefined;
  const wp = findWikipedia(props.wikipedia);
  new maplibregl.Popup({ maxWidth: '320px' })
    .setLngLat(coords)
    .setHTML(buildPopupHTML(props, wd, wp))
    .addTo(mapInstance);
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
  const coords = (feature.geometry as any).coordinates.slice() as [number, number];
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
              distance: haversine(lat, lng, f.geometry.coordinates[1], f.geometry.coordinates[0]),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 10);

          setNearby(withDist);

          mapInstance.flyTo({ center: [lng, lat], zoom: 16, duration: 800 });
        });
      } catch (err) {
        console.error('Ошибка загрузки данных:', err);
      }
    });
  }, []);

  const handleNearbyClick = (item: NearbyItem) => {
    if (!map.current) return;
    map.current.flyTo({ center: item.coords, zoom: 17, duration: 1000 });
    const showPopup = (map.current as any)._showPopup;
    if (showPopup) {
      setTimeout(() => showPopup(item.props, item.coords), 1100);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Нижний Новгород — путеводитель</h1>
      </header>
      <div className="content">
        <aside className="sidebar">
          {!userPos && (
            <p className="hint">
              Нажми кнопку <b>«Где я»</b> на карте справа — покажу, что интересного рядом.
            </p>
          )}
          {userPos && nearby.length === 0 && (
            <p className="hint">Рядом ничего не нашлось. Попробуй переместиться ближе к центру.</p>
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
        </aside>
        <div ref={mapContainer} className="map" />
      </div>
    </div>
  );
}

export default App;