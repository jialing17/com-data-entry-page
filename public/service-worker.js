const CACHE_NAME = 'data-entry-v1';
const formTypes = ['baseline', 'pyrocks', 'donutech', 'sg'];

// Static assets to pre-cache
const staticAssets = [
  '/',
  '/operators',
  '/style.css',
  '/logo.png',
  '/offline.html'
];

// Install event - cache static assets + all event and form pages
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      
      // Cache static assets
      console.log('Caching static assets...');
      await cache.addAll(staticAssets).catch(err => {
        console.log('Some static assets could not be cached:', err);
      });
      
      // Fetch all event IDs and cache event and form pages
      try {
        const response = await fetch('/api/events-list');
        const events = await response.json();
        
        const pageUrls = [];
        events.forEach(event => {
          pageUrls.push(`/events/${event.id}`);
          formTypes.forEach(type => {
            pageUrls.push(`/events/${event.id}/forms/${type}`);
          });
        });
        
        console.log(`Caching ${pageUrls.length} event and form pages...`);
        await cache.addAll(pageUrls).catch(err => {
          console.log('Some pages could not be cached:', err);
        });
      } catch (err) {
        console.log('Could not pre-cache event/form pages:', err);
      }
      
      self.skipWaiting();
    })()
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Listen for messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'REFRESH_PAGE_CACHE') {
    // online — silently recache all event and form pages
    console.log('SW: REFRESH_PAGE_CACHE received, recaching all form pages...');
    refreshPageCache();
  }
});

// recache all event detail and form pages to show fresh data
async function refreshPageCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    
    // Fetch the list of all event IDs from the server
    const listResponse = await fetch('/api/events-list', { cache: 'no-store' });
    const events = await listResponse.json();
    
    const pageUrls = [];
    events.forEach(event => {
      pageUrls.push(`/events/${event.id}`);
      formTypes.forEach(type => {
        pageUrls.push(`/events/${event.id}/forms/${type}`);
      });
    });
    
    console.log(`SW: Recaching ${pageUrls.length} event/form pages...`);
    
    // Fetch each page fresh and update the cache
    for (const url of pageUrls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(url, response);
        }
      } catch (err) {
        console.log(`SW: Could not refresh cache for ${url}:`, err);
      }
    }
    
    console.log('SW: Page cache refreshed successfully');
  } catch (err) {
    console.log('SW: Could not refresh page cache:', err);
  }
}

// Fetch event - use network-first for app pages, cache-first for static assets
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isAppPage = isSameOrigin && (
    url.pathname === '/' ||
    url.pathname === '/operators' ||
    url.pathname.startsWith('/events/')
  );
  const isStaticAsset = isSameOrigin && staticAssets.includes(url.pathname);
  const isHealthCheck = isSameOrigin && url.pathname === '/health';

  // Don't cache health check responses
  if (isHealthCheck) {
    return event.respondWith(fetch(event.request));
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    if (isAppPage) {
      try {
        const response = await fetch(event.request);
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (error) {
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          console.log('Offline fallback serving cached app page:', event.request.url);
          return cachedResponse;
        }
        return new Response('Offline - page not available', { status: 503 });
      }
    }

    if (isStaticAsset) {
      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) {
        console.log('Serving static asset from cache:', event.request.url);
        return cachedResponse;
      }
      try {
        const response = await fetch(event.request);
        if (response && response.status === 200 && response.type === 'basic') {
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (error) {
        console.log('Offline and static asset not cached:', event.request.url);
        return new Response('Offline - resource not available', { status: 503 });
      }
    }

    return fetch(event.request);
  })());
});
