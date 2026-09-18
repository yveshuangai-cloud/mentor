const CACHE='aieq-shell-v2'
const SHELL=['/aieq','/aieq-manifest.webmanifest','/aieq/scenes/start/start-exploration-v1.jpg']
// The worker is registered at "/" but must only touch AI Personality paths; /admin and other apps on this origin pass through untouched.
const owns=path=>path==='/aieq'||path.startsWith('/aieq/')||path==='/aieq-manifest.webmanifest'
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())))
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('aieq-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())))
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!owns(url.pathname))return
// Network first so a new HTML release is never held back; "/aieq?v=..." shares one cache entry instead of growing per replay.
const key=url.pathname==='/aieq'?'/aieq':event.request
event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(key,copy))}return response}).catch(()=>caches.match(key).then(cached=>cached||(event.request.mode==='navigate'?caches.match('/aieq'):undefined)).then(cached=>cached||Response.error())))})
