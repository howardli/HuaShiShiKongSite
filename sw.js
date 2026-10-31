// 手写最小 Service Worker（无依赖、零构建耦合，public/ 直发）——回头客秒开＋离线可全量浏览。
// 策略（同源 GET 才拦截，跨域瓦片等不碰）：
//   导航请求      network-first：新版即时生效；离线回退缓存页（SPA 哈希路由，整站即一页）
//   /assets/*    cache-first：vite 产物带内容哈希，不可变——命中即零网络
//   其余 data 类  stale-while-revalidate：bundle/persons/底图/worker 文件名不带哈希——
//                 缓存版先渲染（瞬时），后台取新版下次生效；首访无缓存走网络
//   品牌资产      同 swr：manifest/图标/og——离线安装态（PWA 图标）与分享卡不破相
// 注册仅生产（main.tsx，dev 下缓存会吞掉热更新）；'./' 相对路径任意子路径部署安全。
// 换版：改 V 前缀即整体作废（activate 清理非当前前缀的旧缓存）。

const V = 'hssk-v2'
const K = { core: `${V}-core`, data: `${V}-data`, pages: `${V}-pages` }

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => !n.startsWith(V)).map((n) => caches.delete(n)))
      await self.clients.claim()
    })()
  )
})

/** 导航：网络优先（部署即生效），断网回缓存页 */
async function netFirstPage(req) {
  try {
    const res = await fetch(req)
    if (res.ok) {
      const c = await caches.open(K.pages)
      await c.put(req, res.clone())
    }
    return res
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) ?? Response.error()
  }
}

/** 不可变资产（带哈希）：命中即回，未命中取网并缓存 */
async function cacheFirst(req) {
  const hit = await caches.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) {
    const c = await caches.open(K.core)
    await c.put(req, res.clone())
  }
  return res
}

/** 后台再校验（去重版）：同 URL 在途只发一次；FRESH_MS 冷却窗口内不重复校验——
 *  无此二者时「一页一次」的访问模式（如全量冒烟）会对每个数据文件每小时打数千个
 *  后台请求，单线程静态服务器被再校验风暴拖垮（2026-10-23 冒烟实测 9 分钟未跑完，
 *  加此两闸后恢复常态） */
const inflight = new Map()
const lastCheck = new Map()
const FRESH_MS = 60_000
function revalidate(req) {
  const k = req.url
  if (Date.now() - (lastCheck.get(k) ?? 0) < FRESH_MS) return
  if (inflight.has(k)) return
  const p = fetch(req)
    .then(async (res) => {
      if (res.ok) {
        const c = await caches.open(K.data)
        await c.put(req, res.clone())
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(k)
      lastCheck.set(k, Date.now())
    })
  inflight.set(k, p)
}

/** 数据类（不带哈希）：缓存版先回（若命中），新版后台入缓存下次生效 */
async function swr(req) {
  const hit = await caches.match(req)
  if (hit) {
    void revalidate(req)
    return hit
  }
  const res = await fetch(req).catch(() => null)
  if (res && res.ok) {
    const c = await caches.open(K.data)
    await c.put(req, res.clone())
  }
  return res ?? Response.error()
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (req.mode === 'navigate') {
    e.respondWith(netFirstPage(req))
    return
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith(cacheFirst(req))
    return
  }
  if (url.pathname.includes('/data/') || url.pathname.endsWith('maplibre-gl-worker.mjs')) {
    e.respondWith(swr(req))
    return
  }
  // 品牌资产（manifest/图标/og）：文件名不带哈希，swr 与 data 类同款；
  // basename 匹配＝子路径部署安全（pathname 带部署前缀）
  const base = url.pathname.split('/').pop() ?? ''
  if (url.pathname.endsWith('.webmanifest') || /^(?:icon-[^/]+\.png|apple-touch-icon\.png|og\.png)$/.test(base)) {
    e.respondWith(swr(req))
  }
  // 其余同源请求（favicon、sw.js 自身等）不拦截
})
