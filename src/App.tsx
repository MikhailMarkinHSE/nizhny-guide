import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

setWorkerUrl(workerUrl);

type WikidataEntry = { label?: string; inception?: string; architect?: string; style?: string; image?: string; article?: string; };
type WikipediaEntry = { extract: string; thumbnail: string | null; url: string | null; };
type NearbyItem = { props: Record<string, string>; coords: [number, number]; distance: number; };
type NavTarget = {
  props: Record<string, string>;
  coords: [number, number];
  wd?: WikidataEntry;
  wp?: WikipediaEntry;
  story?: string;
  title: string;
  text: string;
};

function extractQId(url: string): string | null { const m = url.match(/Q\d+$/); return m ? m[0] : null; }
function formatYear(date: string): string { const m = date.match(/^(-?\d{1,4})/); return m ? m[1] : date; }
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; const φ1 = (lat1 * Math.PI) / 180; const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180; const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(1)} км`;
}
function computeBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
}
function getObjectType(props: Record<string, string>): 'building' | 'memorial' | 'other' {
  if (props.memorial || props['memorial:subject'] || props['memorial:type']) return 'memorial';
  if (props.building || props['building:architecture'] || props['building:levels']) return 'building';
  return 'other';
}
function cleanTextForSpeech(text: string): string {
  let s = text;
  s = s.replace(/[*_#`~]/g, ''); s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/\bул\.\s*/g, 'улица '); s = s.replace(/\bд\.\s*/g, 'дом ');
  s = s.replace(/\bгг\.\s*/g, 'годы '); s = s.replace(/\bг\.\s*(?=\d)/g, 'года ');
  s = s.replace(/\bг\.\s*/g, 'город '); s = s.replace(/\bвв\.\s*/g, 'века ');
  s = s.replace(/\bв\.\s*/g, 'век '); s = s.replace(/\bпр\.\s*/g, 'проспект ');
  s = s.replace(/\bпл\.\s*/g, 'площадь '); s = s.replace(/\bнаб\.\s*/g, 'набережная ');
  s = s.replace(/\bпер\.\s*/g, 'переулок '); s = s.replace(/\bш\.\s*/g, 'шоссе ');
  s = s.replace(/[|/\\<>]/g, ' '); s = s.replace(/[–—]/g, ', ');
  s = s.replace(/\s+/g, ' ').replace(/\.{2,}/g, '.'); s = s.trim();
  if (s && !/[.!?]$/.test(s)) s += '.';
  return s;
}
function speakText(text: string) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const cleanText = cleanTextForSpeech(text);
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'ru-RU'; utterance.rate = 1.0; utterance.pitch = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const preferred = ['Milena', 'Microsoft Irina', 'Google русский', 'Yuri', 'Katya'];
  let ruVoice: SpeechSynthesisVoice | undefined;
  for (const name of preferred) { ruVoice = voices.find(v => v.name.includes(name)); if (ruVoice) break; }
  if (!ruVoice) ruVoice = voices.find(v => v.lang === 'ru-RU' || v.lang.startsWith('ru'));
  if (ruVoice) utterance.voice = ruVoice;
  setTimeout(() => window.speechSynthesis.speak(utterance), 100);
}
(window as any).stopSpeech = () => { window.speechSynthesis.cancel(); };

function generateFallbackStory(props: Record<string, string>, type: string): string {
  const bits: string[] = [];
  if (type === 'building') {
    if (props['building:architecture']) bits.push(`в стиле ${props['building:architecture']}`);
    const year = props['year_of_construction'] || props.start_date;
    if (year) bits.push(`${formatYear(year)} года`);
    if (bits.length) return `Здание ${bits.join(', ')}.`;
  }
  if (type === 'memorial' && props['memorial:subject']) return `Памятник, посвящённый ${props['memorial:subject']}.`;
  return 'Историческое место в Нижнем Новгороде.';
}

function buildPopupHTML(
  props: Record<string, string>, wd: WikidataEntry | undefined, wp: WikipediaEntry | undefined, story: string | undefined,
  coords: [number, number]
): { html: string; text: string } {
  const type = getObjectType(props);
  const title = wd?.label || props.name || props['name:ru'] || `${props['addr:street'] || ''} ${props['addr:housenumber'] || ''}`.trim() || (type === 'memorial' ? 'Мемориал' : 'Историческое место');

  const style = wd?.style || props['building:architecture'];
  const styleBadge = style ? `<span class="badge">${style}</span>` : '';

  let mainStory = '';
  if (wp?.extract) mainStory = wp.extract.length > 500 ? wp.extract.slice(0, 500).trim() + '…' : wp.extract;
  else if (story) mainStory = story;
  else if (props.description) mainStory = props.description;
  else if (props.inscription) mainStory = `«${props.inscription}»`;
  else mainStory = generateFallbackStory(props, type);

  const spokenText = `${title}. ${mainStory}`;
  const facts: string[] = [];

  if (type === 'building') {
    const year = wd?.inception || props['year_of_construction'] || props.start_date;
    if (year) facts.push(`<div class="fact"><span class="fact-label">Год</span><span class="fact-value">${formatYear(year)}</span></div>`);
    const architect = wd?.architect || props.architect;
    if (architect) facts.push(`<div class="fact"><span class="fact-label">Архитектор</span><span class="fact-value">${architect}</span></div>`);
    if (props['building:levels']) facts.push(`<div class="fact"><span class="fact-label">Этажей</span><span class="fact-value">${props['building:levels']}</span></div>`);
  }
  if (type === 'memorial' && props['memorial:subject']) facts.push(`<div class="fact"><span class="fact-label">Посвящён</span><span class="fact-value">${props['memorial:subject']}</span></div>`);
  if (props['addr:street']) facts.push(`<div class="fact"><span class="fact-label">Адрес</span><span class="fact-value">${props['addr:street']}, ${props['addr:housenumber'] || ''}</span></div>`);
  if (props['heritage:name'] || props.heritage) facts.push(`<div class="fact"><span class="fact-label">Наследие</span><span class="fact-value">${props['heritage:name'] || props.heritage}</span></div>`);

  const img = wd?.image || wp?.thumbnail;
  const links: string[] = [];
  if (wd?.article) links.push(`<a href="${wd.article}" target="_blank" rel="noopener">Википедия →</a>`);
  else if (wp?.url) links.push(`<a href="${wp.url}" target="_blank" rel="noopener">Читать полностью →</a>`);

  const hasDetails = facts.length > 0 || img || links.length > 0;

  const navEncoded = encodeURIComponent(JSON.stringify({ props, coords })).replace(/'/g, '%27');

  const html = `
    <div class="popup">
      <div class="popup-header">
        <div class="popup-title-wrap">
          <h3 class="popup-title">${title}</h3>
          ${styleBadge}
        </div>
        <button onclick="window.stopSpeech()" class="popup-stop" title="Остановить">⏹</button>
      </div>
      <p class="popup-story">${mainStory}</p>
      <button onclick="window.startGvidonNav('${navEncoded}')" class="popup-nav-btn">🧭 Хочу сюда</button>
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
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('gvidon-visited'));

  const [navTarget, setNavTarget] = useState<NavTarget | null>(null);
  const [navHeading, setNavHeading] = useState<number | null>(null);
  const [navPos, setNavPos] = useState<[number, number] | null>(null);
  const [navDistance, setNavDistance] = useState<number | null>(null);
  const [navArrived, setNavArrived] = useState(false);

  const featuresRef = useRef<any[]>([]);
  const hasAutoOpenedSheet = useRef(false);
  const visitedIds = useRef<Set<string>>(new Set());
  const navWatchId = useRef<number | null>(null);
  const wikidataMapRef = useRef<Map<string, WikidataEntry>>(new Map());
  const wikipediaMapRef = useRef<Map<string, WikipediaEntry>>(new Map());
  const storiesMapRef = useRef<Record<string, string>>({});
  const findWikipediaRef = useRef<(tag: string | undefined) => WikipediaEntry | undefined>(() => undefined);
  const handleStartNavRef = useRef<(props: Record<string, string>, coords: [number, number]) => void>(() => {});

  // Глобальный обработчик из попапа
  useEffect(() => {
    (window as any).startGvidonNav = (encoded: string) => {
      try {
        const { props, coords } = JSON.parse(decodeURIComponent(encoded));
        handleStartNavRef.current(props, coords);
      } catch (e) { console.error('startGvidonNav error:', e); }
    };
  }, []);

  // Эффект: слежение за позицией + компас во время навигации
  useEffect(() => {
    if (!navTarget) return;

    // Позиция
    navWatchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setNavPos([longitude, latitude]);
        const d = haversine(latitude, longitude, navTarget.coords[1], navTarget.coords[0]);
        setNavDistance(d);
        if (d < 20 && !navArrived) setNavArrived(true);
      },
      (err) => console.error('GPS error:', err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );

    // Компас
    let absoluteSupported = false;
    const absHandler = (e: DeviceOrientationEvent) => {
      absoluteSupported = true;
      const webkit = (e as any).webkitCompassHeading;
      if (typeof webkit === 'number' && webkit >= 0) { setNavHeading(webkit); return; }
      if (e.alpha !== null && e.alpha !== undefined) setNavHeading((360 - e.alpha) % 360);
    };
    const relHandler = (e: DeviceOrientationEvent) => {
      if (absoluteSupported) return;
      const webkit = (e as any).webkitCompassHeading;
      if (typeof webkit === 'number' && webkit >= 0) { setNavHeading(webkit); return; }
      if (e.alpha !== null && e.alpha !== undefined) setNavHeading((360 - e.alpha) % 360);
    };
    window.addEventListener('deviceorientationabsolute', absHandler);
    window.addEventListener('deviceorientation', relHandler);

    return () => {
      if (navWatchId.current !== null) {
        navigator.geolocation.clearWatch(navWatchId.current);
        navWatchId.current = null;
      }
      window.removeEventListener('deviceorientationabsolute', absHandler);
      window.removeEventListener('deviceorientation', relHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTarget]);

  // Когда прибыли — включаем аудио и помечаем посещённым
  useEffect(() => {
    if (navArrived && navTarget) {
      speakText(navTarget.text);
      const id = navTarget.props['@id'] || (navTarget.props as any).id;
      if (id) visitedIds.current.add(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navArrived]);

  const handleStartNav = (props: Record<string, string>, coords: [number, number]) => {
    const qid = props.wikidata;
    const wd = qid ? wikidataMapRef.current.get(qid) : undefined;
    const wp = findWikipediaRef.current(props.wikipedia);
    const id = props['@id'] || (props as any).id;
    const story = id ? storiesMapRef.current[id] : undefined;
    const { text } = buildPopupHTML(props, wd, wp, story, coords);
    const title = wd?.label || props.name || props['name:ru'] || `${props['addr:street'] || ''} ${props['addr:housenumber'] || ''}`.trim() || 'Историческое место';

    setNavTarget({ props, coords, wd, wp, story, title, text });
    setNavArrived(false);
    setNavPos(null);
    setNavDistance(null);

    // Запрос разрешения на компас (iOS) — синхронно, в жесте пользователя
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      (DeviceOrientationEvent as any).requestPermission().catch(() => {});
    }
  };
  handleStartNavRef.current = handleStartNav;

  const handleCloseNav = () => {
    window.speechSynthesis.cancel();
    setNavTarget(null);
    setNavArrived(false);
    setNavHeading(null);
    setNavPos(null);
    setNavDistance(null);
  };

  const findNextNearest = (): { props: Record<string, string>; coords: [number, number] } | null => {
    const pos = navPos || userPos;
    if (!pos) return null;
    let best: any = null;
    let bestDist = Infinity;
    for (const f of featuresRef.current) {
      const id = f.properties['@id'] || f.id;
      if (visitedIds.current.has(id)) continue;
      const d = haversine(pos[1], pos[0], f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (d < bestDist && d < 500) { bestDist = d; best = f; }
    }
    return best ? { props: best.properties, coords: best.geometry.coordinates } : null;
  };

  const handleNext = () => {
    window.speechSynthesis.cancel();
    const next = findNextNearest();
    if (next) {
      handleStartNav(next.props, next.coords);
    } else {
      alert('Больше интересных мест рядом нет. Возвращайтесь на карту!');
      handleCloseNav();
    }
  };

  // Основной эффект с картой
  useEffect(() => {
    if (map.current || !mapContainer.current) return;

    const unlockAudio = () => {
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(''); window.speechSynthesis.speak(u); }
      document.removeEventListener('touchstart', unlockAudio);
      document.removeEventListener('click', unlockAudio);
    };
    document.addEventListener('touchstart', unlockAudio);
    document.addEventListener('click', unlockAudio);

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
      center: [44.0059, 56.3269], zoom: 14,
    });

    map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }, trackUserLocation: false, showAccuracyCircle: false });
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
        storiesMapRef.current = llmRes as Record<string, string>;
        const wikidataMap = new Map<string, WikidataEntry>();
        for (const b of wdRes.results.bindings) {
          const val = (v: any): string | undefined => typeof v === 'string' ? v : v?.value;
          const itemUrl = val(b.item); const qid = itemUrl ? extractQId(itemUrl) : null; if (!qid) continue;
          const existing = wikidataMap.get(qid) || {};
          const label = val(b.itemLabel); if (label && !existing.label) existing.label = label;
          const inception = val(b.inception); if (inception && !existing.inception) existing.inception = formatYear(inception);
          const architect = val(b.architectLabel); if (architect) existing.architect = existing.architect ? `${existing.architect}, ${architect}` : architect;
          const style = val(b.architecturalStyleLabel); if (style && !existing.style) existing.style = style;
          const image = val(b.image); if (image && !existing.image) existing.image = image;
          const article = val(b.article); if (article && !existing.article) existing.article = article;
          wikidataMap.set(qid, existing);
        }
        wikidataMapRef.current = wikidataMap;

        const normalize = (s: string): string => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
        const wikipediaMap = new Map<string, WikipediaEntry>();
        for (const [title, entry] of Object.entries(wpRes as Record<string, WikipediaEntry>)) { wikipediaMap.set(normalize(title), entry); wikipediaMap.set(title, entry); }
        wikipediaMapRef.current = wikipediaMap;
        const findWikipedia = (tag: string | undefined): WikipediaEntry | undefined => {
          if (!tag) return undefined; const [lang, ...rest] = tag.split(':'); if (!lang) return undefined;
          const title = rest.join(':').split('#')[0].trim(); if (!title) return undefined;
          return wikipediaMap.get(title) || wikipediaMap.get(normalize(title)) || undefined;
        };
        findWikipediaRef.current = findWikipedia;

        const filtered = { type: 'FeatureCollection' as const, features: osmRes.features };
        featuresRef.current = filtered.features;

        mapInstance.addSource('historic', { type: 'geojson', data: filtered, cluster: true, clusterRadius: 50, clusterMaxZoom: 15 });
        mapInstance.addLayer({ id: 'clusters', type: 'circle', source: 'historic', filter: ['has', 'point_count'], paint: { 'circle-color': ['step', ['get', 'point_count'], '#e63946', 10, '#f77f00', 30, '#d62828'], 'circle-radius': ['step', ['get', 'point_count'], 18, 10, 24, 30, 30], 'circle-stroke-width': 3, 'circle-stroke-color': '#000000', 'circle-opacity': 0.9 } });
        mapInstance.addLayer({ id: 'cluster-count', type: 'symbol', source: 'historic', filter: ['has', 'point_count'], layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 13 }, paint: { 'text-color': '#000000' } });
        mapInstance.addLayer({ id: 'unclustered-point-bg', type: 'circle', source: 'historic', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': ['case', ['has', 'memorial'], '#3a86ff', '#e63946'], 'circle-radius': 14, 'circle-stroke-width': 3, 'circle-stroke-color': '#000000' } });
        mapInstance.addLayer({ id: 'unclustered-point-icon', type: 'symbol', source: 'historic', filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['case', ['has', 'memorial'], '🕯', '🏛'], 'text-size': 14, 'text-allow-overlap': true } });

        const showPopup = (props: Record<string, string>, coords: [number, number]) => {
          const qid = props.wikidata; const wd = qid ? wikidataMapRef.current.get(qid) : undefined;
          const wp = findWikipediaRef.current(props.wikipedia);
          const id = props['@id'] || (props as any).id;
          const story = id ? storiesMapRef.current[id] : undefined;
          const { html, text } = buildPopupHTML(props, wd, wp, story, coords);
          const popup = new maplibregl.Popup({ maxWidth: '340px' }).setLngLat(coords).setHTML(html).addTo(mapInstance);
          speakText(text);
          popup.on('close', () => { (window as any).stopSpeech(); });
        };
        (mapInstance as any)._showPopup = showPopup;

        mapInstance.on('click', 'clusters', (e) => {
          const features = mapInstance.queryRenderedFeatures(e.point, { layers: ['clusters'] });
          const feature = features[0]; if (!feature) return;
          const clusterId = feature.properties?.cluster_id;
          const source = mapInstance.getSource('historic') as maplibregl.GeoJSONSource;
          source.getClusterExpansionZoom(clusterId).then((zoom) => { const coords = (feature.geometry as any).coordinates; mapInstance.easeTo({ center: coords, zoom }); });
        });

        for (const layerId of ['unclustered-point-bg', 'unclustered-point-icon']) {
          mapInstance.on('click', layerId, (e) => {
            const feature = e.features?.[0]; if (!feature) return;
            const props = feature.properties; if (!props) return;
            const coords = (feature.geometry as any).coordinates.slice() as [number, number];
            showPopup(props, coords);
          });
          mapInstance.on('mouseenter', layerId, () => { mapInstance.getCanvas().style.cursor = 'pointer'; });
          mapInstance.on('mouseleave', layerId, () => { mapInstance.getCanvas().style.cursor = ''; });
        }

        geolocate.on('geolocate', (e: any) => {
          const lng = e.coords.longitude; const lat = e.coords.latitude;
          setUserPos([lng, lat]);
          const withDist: NearbyItem[] = featuresRef.current.map((f: any) => ({ props: f.properties, coords: f.geometry.coordinates as [number, number], distance: haversine(lat, lng, f.geometry.coordinates[1], f.geometry.coordinates[0]) })).sort((a, b) => a.distance - b.distance).slice(0, 10);
          setNearby(withDist);
          if (!hasAutoOpenedSheet.current) { setSheetOpen(true); hasAutoOpenedSheet.current = true; }
        });
      } catch (err) { console.error('Ошибка загрузки данных:', err); }
    });

    return () => {
      if (mapContainer.current) mapContainer.current.removeEventListener('touchstart', closeSheet);
    };
  }, []);

  const handleNearbyClick = (item: NearbyItem) => {
    if (!map.current) return;
    map.current.flyTo({ center: item.coords, zoom: 17, duration: 1000 });
    const showPopup = (map.current as any)._showPopup;
    if (showPopup) setTimeout(() => showPopup(item.props, item.coords), 1100);
    setSheetOpen(false);
  };

  const sidebarContent = (
    <>
      {!userPos && <p className="hint">Нажми кнопку <b>«Где я»</b> на карте — покажу, что интересного рядом.</p>}
      {userPos && nearby.length === 0 && <p className="hint">Рядом ничего не нашлось. Попробуй переместиться ближе к центру.</p>}
      {nearby.length > 0 && (
        <>
          <h2>Рядом с тобой</h2>
          <ul className="nearby-list">
            {nearby.map((item, i) => {
              const title = item.props.name || item.props['name:ru'] || `${item.props['addr:street'] || ''} ${item.props['addr:housenumber'] || ''}`.trim() || 'Историческое место';
              const type = getObjectType(item.props);
              const isMemorial = type === 'memorial';
              return (
                <li key={i} onClick={() => handleNearbyClick(item)} className={isMemorial ? 'is-memorial' : ''}>
                  <div className="nearby-row">
                    <div className="nearby-main">
                      <div className="nearby-title">{title}</div>
                      <div className="nearby-distance">{isMemorial ? '🕯 ' : '🏛 '}{formatDistance(item.distance)}</div>
                    </div>
                    <button
                      className="nearby-nav-btn"
                      onClick={(e) => { e.stopPropagation(); handleStartNav(item.props, item.coords); }}
                      title="Хочу сюда"
                    >🧭</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );

  // Навигация
  const navBearing = (navTarget && navPos)
    ? computeBearing(navPos[1], navPos[0], navTarget.coords[1], navTarget.coords[0])
    : null;
  const arrowRotation = navBearing !== null
    ? (navHeading !== null ? (navBearing - navHeading + 360) % 360 : navBearing)
    : 0;

  return (
    <div className="app">
      <header className="header">
        <button className="header-menu" onClick={() => setMenuOpen(true)} aria-label="Меню">☰</button>
        <div className="header-brand"><img src="/icon-192.png" alt="" className="header-logo" /><h1>Гвидон</h1></div>
        <div className="header-spacer" />
      </header>

      <div className="content">
        <aside className="sidebar">{sidebarContent}</aside>
        <div ref={mapContainer} className="map" />
      </div>

      <div className={`sheet ${sheetOpen ? 'sheet-open' : ''}`}>
        <button className="sheet-handle" onClick={() => setSheetOpen((v) => !v)}>{sheetOpen ? '▼' : '▲'} Рядом с тобой</button>
        <div className="sheet-content">{sidebarContent}</div>
      </div>

      {/* НАВИГАЦИЯ */}
      {navTarget && (
        <div className="nav-overlay">
          <button className="nav-close" onClick={handleCloseNav} aria-label="Закрыть">×</button>
          <div className="nav-content">
            {navTarget.wd?.image || navTarget.wp?.thumbnail ? (
              <img src={navTarget.wd?.image || navTarget.wp?.thumbnail || ''} alt="" className="nav-photo" />
            ) : (
              <div className="nav-photo-placeholder">🏛</div>
            )}

            <h1 className="nav-title">{navTarget.title}</h1>

            {!navArrived && (
              <>
                <div className="nav-compass-wrap">
                  <div className="nav-compass">
                    <div className="nav-compass-ring" />
                    <div className="nav-arrow" style={{ transform: `rotate(${arrowRotation}deg)` }}>▲</div>
                  </div>
                  <div className="nav-compass-n">N</div>
                </div>

                <p className="nav-distance">
                  {navDistance !== null ? formatDistance(navDistance) : 'Определяем...'}
                </p>
                <p className="nav-hint">
                  {navHeading === null
                    ? 'Идите по компасу. Наведите телефон по стрелке.'
                    : 'Повернись по стрелке — она указывает на здание.'}
                </p>

                <button className="nav-arrived-btn" onClick={() => setNavArrived(true)}>
                  Я на месте
                </button>
              </>
            )}

            {navArrived && (
              <>
                <div className="nav-arrived-badge">✓ Вы на месте</div>
                <p className="nav-arrived-text">Слушайте рассказ</p>
                <button className="nav-action-btn" onClick={() => speakText(navTarget.text)}>
                  🔊 Слушать ещё раз
                </button>
                <button className="nav-action-btn nav-next-btn" onClick={handleNext}>
                  → Следующая точка
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {menuOpen && (
        <div className="menu-overlay" onClick={() => setMenuOpen(false)}>
          <div className="menu-panel" onClick={(e) => e.stopPropagation()}>
            <button className="menu-close" onClick={() => setMenuOpen(false)}>×</button>
            <h2 className="menu-title">Меню</h2>
            <button className="menu-item" onClick={() => { setMenuOpen(false); setShowWelcome(true); }}>О приложении</button>
            <button className="menu-item" onClick={() => {
              if (confirm('Сбросить кэш? Приложение перезагрузится.')) {
                localStorage.clear();
                if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
                setTimeout(() => window.location.reload(), 300);
              }
            }}>Сбросить кэш</button>
          </div>
        </div>
      )}

      {showWelcome && (
        <div className="welcome">
          <div className="welcome-content">
            <img src="/icon-192.png" alt="Гвидон" className="welcome-logo-img" />
            <h1 className="welcome-title">Гвидон</h1>
            <p className="welcome-tagline">Guide on</p>
            <p className="welcome-hint">Твой личный гид по Нижнему Новгороду.<br/>Нажми на здание или выбери «Хочу сюда» — и голосовой гид поведёт тебя.</p>
            <button className="welcome-btn" onClick={() => { localStorage.setItem('gvidon-visited', '1'); setShowWelcome(false); }}>Начать прогулку</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;