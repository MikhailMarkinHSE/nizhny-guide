export const config = {
  matcher: '/((?!_next|favicon.ico|.*\\.(?:js|css|png|jpg|jpeg|svg|ico|json|geojson|mjs|woff2?)).*)',
};

export default function middleware(request: Request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader?.startsWith('Basic ')) {
    try {
      const encoded = authHeader.slice(6);
      const [user, password] = atob(encoded).split(':');

      const expectedUser = process.env.BASIC_AUTH_USER || 'admin';
      const expectedPass = process.env.BASIC_AUTH_PASS || '';

      if (user === expectedUser && password === expectedPass) {
        return; // пропускаем — браузер уже авторизован
      }
    } catch {
      // битый заголовок — ниже вернём 401
    }
  }

  return new Response('Требуется авторизация', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Gvidon", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}