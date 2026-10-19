import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// ============================================================
// Автоматическое обновление PWA
// ============================================================
if ('serviceWorker' in navigator) {
  // 1. Проверка обновлений каждый час (если вкладка открыта долго)
  setInterval(() => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) reg.update();
    });
  }, 60 * 60 * 1000);

  // 2. Проверка при возврате на вкладку (переключение с другого приложения)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg) reg.update();
      });
    }
  });

  // 3. Когда найден и активирован новый SW — перезагружаем страницу
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}