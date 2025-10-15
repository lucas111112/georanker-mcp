/*  GeoRanker MCP Server – v1.5.23  (October‑2025)
    • SERP: fix “Bad input parameter” by normalizing payloads (keyword, isMobile, maxResults≥10, defaults)
    • Regions: resolve ISO2 + language tails (US-en → US), robust matching against /region/list
    • Bulk ops: build & validate each item, post plain arrays to *list endpoints
    • Deletes: trim + encode IDs
    • Retries: include 500/502/504/429
    • Teaching: rich tool descriptions + inputSchema.examples (for oneshot calls), Smart Hints only when we auto-correct (GR_HINTS=off to disable)
---------------------------------------------------------------- */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { HttpsAgent } from 'agentkeepalive';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import pLimit from 'p-limit';

dotenv.config();

/* ---------- very‑light argv parser ---------- */
function argvKey () {
  const idx = process.argv.findIndex(a => a === '--apikey' || a.startsWith('--apikey='));
  if (idx === -1) return undefined;
  const direct = process.argv[idx];
  if (direct.includes('=')) return direct.split('=')[1];
  return process.argv[idx + 1];
}

/* ───────────────── Config & HTTP ───────────────── */

const API_KEY  = argvKey() || process.env.GEORANKER_API_KEY;
const API_BASE = (process.env.GEORANKER_API_BASE_URL || 'https://api.highvolume.georanker.com')
                  .replace(/^http:/, 'https:');     // disallow plain HTTP
if (!API_KEY) {
  console.error(`
❌  GeoRanker API key missing.

Supply it through either method:

  • ENV var :  GEORANKER_API_KEY=sk_live_xxx  npx georanker-mcp
  • CLI flag:  npx georanker-mcp --apikey sk_live_xxx

Or in an MCP manifest:

  "georanker": {
    "command": "npx",
    "args": ["-y", "georanker-mcp@latest"],
    "env":  { "GEORANKER_API_KEY": "<your key>" }
  }
`);
  process.exit(1);
}

const HINTS_MODE = String(process.env.GR_HINTS || 'auto').toLowerCase(); // 'auto' | 'off'
const SHOULD_HINT = (changed) => HINTS_MODE !== 'off' && !!changed;

const http = axios.create({
  baseURL : API_BASE,
  timeout : 30_000,
  headers : { 'User-Agent':'GeoRanker-MCP/1.5.23', 'Content-Type':'application/json' },
  httpsAgent: new HttpsAgent({ keepAlive:true, maxSockets:64 })
});

axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  // Retry network errors, 429, and common transient 5xx
  retryCondition: (err) => {
    const s = err?.response?.status;
    return axiosRetry.isNetworkOrIdempotentRequestError(err) || s === 429 || s === 500 || s === 502 || s === 504;
  }
});

const VERBOSE = !!process.env.GR_VERBOSE || process.argv.includes('--verbose');
const vLog    = (...a) => VERBOSE && console.error('[GR-DEBUG]', ...a);

/* ───────────────── Region helpers (with 24 h disk cache) ───────────────── */

const CACHE_FILE = path.join(os.tmpdir(), 'georanker-regions.json');
const REGION_ALIASES = { UK:'GB', USA:'US' };
let   regionCache = null;

async function loadRegions () {
  if (regionCache) return regionCache;

  if (fs.existsSync(CACHE_FILE)) {
    try {
      const {ts, data} = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - ts < 86_400_000) { regionCache = data; return data; }
    } catch {/* ignore */ }
  }

  const raw = await http.get('/region/list', { params:{apikey:API_KEY} })
                        .then(r => r.data)
                        .catch(() => []);
  regionCache = Array.isArray(raw) ? raw :
                Array.isArray(raw.regions) ? raw.regions : [];
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ts:Date.now(), data:regionCache})); } catch {}
  return regionCache;
}

const norm = s => String(s||'').trim().toLowerCase();

/**
 * Accepts:
 *  - numeric id (string/number)
 *  - "ChI..." (kept as-is)
 *  - ISO2 like "US" / "GB"
 *  - "US-en" / "BR-pt" etc. (language tail ignored)
 *  - canonical or formatted region names (e.g., "London,England,United Kingdom")
 * Returns:
 *  - number (id) OR canonical/formatted string (as API accepts both), OR undefined
 */
async function resolveRegion (input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number')  return input;
  if (/^\d+$/.test(input))        return Number(input);
  if (/^ChI/.test(input))         return input; // keep

  const txt   = String(input).trim();
  const parts = txt.split(/[-_]/);
  let cc      = (parts[0] || '').toUpperCase();
  cc          = REGION_ALIASES[cc] || cc;

  // If parts[1] is a language code (en, pt, zh, ...), ignore it for region lookup:
  const isLang = parts[1] && /^[a-z]{2,3}$/i.test(parts[1]);
  const tail   = parts.slice(isLang ? 2 : 1).join(' ').trim();

  const regions = await loadRegions();
  if (!regions.length) return undefined;

  // ISO2 country only:
  if (!tail && cc.length === 2) {
    const hit = regions.find(r => r.code === cc);
    if (hit) return Number(hit.id) || hit.code;
  }

  // Country + tail (state, city, etc.)
  if (tail) {
    const hit = regions.find(r =>
      (r.code===cc || r.countryCode===cc) &&
      (norm(r.canonicalName).includes(norm(tail)) ||
       norm(r.formattedName).includes(norm(tail))));
    if (hit) return Number(hit.id) || hit.canonicalName || hit.formattedName;
  }

  // Exact name match fallback
  const nameHit = regions.find(r => norm(r.canonicalName) === norm(txt) ||
                                    norm(r.formattedName) === norm(txt));
  return nameHit ? (Number(nameHit.id) || nameHit.canonicalName || nameHit.formattedName) : undefined;
}

function parseLoc (raw) {
  if (!raw) return {};
  const [cc, maybeLang] = String(raw).split(/[-_]/);
  return {
    regionCode: cc?.toUpperCase(),
    language  : (maybeLang && /^[a-z]{2,3}$/i.test(maybeLang)) ? maybeLang.toLowerCase() : undefined
  };
}

/* ───────────────── Builders ───────────────── */

const txt = o => [{ type: 'text', text: JSON.stringify(o, null, 2) }];

function withHint(result, hint) {
  if (!hint) return txt(result);
  return [
    ...txt(result),
    { type: 'text', text: `💡 Hint: ${hint}` }
  ];
}

const clampInt = (v, min, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
};

async function buildSerp (p) {
  const keyword = String(p?.keyword ?? '').trim();
  if (!keyword) throw new Error('Bad input: "keyword" is required and must be non-empty');

  const loc = parseLoc(p.region);

  // Try resolve the user-provided region first; if that fails but we parsed an ISO2 (e.g., US from "US-en"),
  // try resolving the ISO2 as a fallback.
  let region;
  if (p.region !== undefined) {
    region = await resolveRegion(p.region);
    if (region === undefined && loc.regionCode) {
      region = await resolveRegion(loc.regionCode);
    }
  } else if (loc.regionCode) {
    region = await resolveRegion(loc.regionCode);
  }

  const maxNorm  = clampInt(p.maxResults ?? 10, 10, 100); // enforce ≥10 (API rejects smaller)
  const priority = ['LOW','NORMAL','REALTIME','INSTANT'].includes(p.priority) ? p.priority : 'NORMAL';
  const engine   = (p.searchEngine ?? 'google');

  return {
    keyword,
    ...(region !== undefined ? { region } : {}),
    ...(p.language||loc.language ? { language: p.language||loc.language } : {}),
    searchEngine: engine,
    ...(maxNorm !== undefined ? { maxResults: maxNorm } : {}),
    priority,
    ...(p.device ? { isMobile: p.device === 'mobile' } :
       (p.isMobile !== undefined ? { isMobile: !!p.isMobile } : {})),
    ...(p.saveRawData ? { saveRawData: !!p.saveRawData } : {}),
    ...(p.customUserAgent ? { customUserAgent: p.customUserAgent } : {})
  };
}

async function buildKeyword (base) {
  const loc      = parseLoc(base.region);
  const region   = await resolveRegion(base.region ?? loc.regionCode);
  return {
    ...(Array.isArray(base.keywords) ? { keywords: base.keywords } : {}),
    ...(base.url ? { url: base.url } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(base.language||loc.language ? { language: base.language||loc.language } : {}),
    ...(base.source ? { source: base.source } : {}), // google | baidu
    ...(base.searchPartners !== undefined ? { searchPartners: !!base.searchPartners } : {}),
    ...(base.suggestions !== undefined ? { suggestions: !!base.suggestions } : {}),
    ...(base.priority ? { priority: base.priority } : {}),
  };
}

/* ───────────────── HTTP small helpers ───────────────── */

async function call (path, opts={}) {
  try {
    if (VERBOSE && opts.data) vLog('REQUEST', path, '\n', JSON.stringify(opts.data,null,2));
    return (await http.request({ url:path, params:{apikey:API_KEY}, ...opts })).data;
  } catch (e) {
    const {status, data} = e.response||{};
    vLog('RESPONSE-ERR', {status, data, payload:opts.data});
    // Add small, actionable context for common 400s on create SERP
    const base = `API ${status||''}: ${typeof data==='string'?data:data?.message||'Unknown error'}`;
    const isCreateSerp = (opts.method === 'POST') && /^\/serp\/new/.test(path);
    if (status === 400 && isCreateSerp) {
      const tip = 'Ensure a resolvable region (numeric id or ISO2 like "US"), maxResults ≥ 10, searchEngine "google", and use device:"desktop|mobile" (mapped to isMobile).';
      throw new Error(`${base} — ${tip}`);
    }
    throw new Error(base);
  }
}

async function pollReady (path, timeout=180_000) {
  let delay = 5_000;
  const t0  = Date.now();
  while (true) {
    const j = await call(path);
    if (j?.ready) return j;
    if (Date.now() - t0 > timeout) throw new Error('poll timeout');
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 20_000);
  }
}

/* ───────────────── MCP Server ───────────────── */

const server = new Server({
  name: 'GeoRanker',
  version: '1.5.23'
}, {
  capabilities: {
    tools: {},
    resources: {}
  }
});

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'georanker://regions',
      name: 'Available regions',
      description: 'List of all available regions for GeoRanker queries',
      mimeType: 'application/json'
    },
    {
      uri: 'georanker://help',
      name: 'GeoRanker MCP quick reference',
      description: 'Short guide on minimal payloads & priorities',
      mimeType: 'text/markdown'
    }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'georanker://regions') {
    const regions = await loadRegions();
    return {
      contents: [{
        uri: 'georanker://regions',
        mimeType: 'application/json',
        text: JSON.stringify(regions, null, 2)
      }]
    };
  }
  if (uri === 'georanker://help') {
    const help = [
      '# GeoRanker MCP – Quick Reference',
      '',
      '**SERP**',
      '- Single create: POST /serp/new; bulk: POST /serp/new/list (body = array of SerpRequest).',
      '- Pass `region` as numeric id or ISO2 (e.g., "US"); `US-en` is accepted (mapped to US).',
      '- `maxResults` ≥ 10; default 10 if omitted.',
      '- Use `device:"mobile|desktop"` (mapped to `isMobile`).',
      '',
      '**Keyword**',
      '- Single: POST /keyword/new; bulk: POST /keyword/new/list (body = array).',
      '- Official suggestions: set `suggestions:true` on /keyword/new (with `asynchronous:false` for sync).',
      '',
      '**Bulk GET**',
      '- /serp/list and /keyword/list expect **plain array of string IDs**.',
      '',
      '**Delete**',
      '- DELETE /serp/{id}, /keyword/{id}; 404 = not found/expired.'
    ].join('\n');
    return {
      contents: [{
        uri: 'georanker://help',
        mimeType: 'text/markdown',
        text: help
      }]
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

/* ───────────────── Tools (with oneshot guidance in descriptions + examples) ───────────────── */

const tools = [
  { name: 'heartbeat',        description: 'Check GeoRanker API status.', inputSchema:{ type:'object', properties:{} } },
  { name: 'get_user',         description: 'Get current user information and credits.', inputSchema:{ type:'object', properties:{} } },
  {
    name: 'list_regions',
    description: 'List geographic regions. TIP: use ISO2 in region fields (e.g., "US") or numeric IDs returned here.',
    inputSchema: {
      type:'object',
      properties: {
        countryCode: { type:'string', description:'ISO-3166-1 alpha-2 (e.g., US)' },
        type: { type:'string', description:'Region type filter' }
      },
      examples: [
        { countryCode: 'US' }
      ]
    }
  },
  {
    name: 'get_whois',
    description: 'Get WHOIS information for a domain.',
    inputSchema: { type:'object', properties:{ domain:{ type:'string' } }, required:['domain'],
      examples: [ { domain:'google.com' } ]
    }
  },
  {
    name: 'get_technologies',
    description: 'Detect web technologies for a domain. (Empty array is a valid “no public data” result.)',
    inputSchema: { type:'object', properties:{ domain:{ type:'string' } }, required:['domain'],
      examples: [ { domain:'github.com' } ]
    }
  },

  /* SERP */
  {
    name: 'create_serp',
    description: 'Create a SERP analysis. Oneshot minimal payload: {keyword, region (ISO2 or id), device:"desktop|mobile", maxResults≥10, searchEngine:"google"}.',
    inputSchema: {
      type:'object',
      properties:{
        keyword:{ type:'string', description:'Required non-empty' },
        region:{ type:'string', description:'Numeric ID or ISO2 (e.g., "US"). "US-en" also accepted.' },
        language:{ type:'string', description:'Optional language code' },
        searchEngine:{ type:'string', description:'Default "google".' },
        maxResults:{ type:'number', minimum:10, description:'Minimum 10' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'], description:'Default NORMAL' },
        device:{ type:'string', enum:['desktop','mobile'], description:'Mapped to isMobile automatically' },
        isMobile:{ type:'boolean', description:'Alternative to device' },
        saveRawData:{ type:'boolean' },
        customUserAgent:{ type:'string' },
        synchronous:{ type:'boolean', description:'If true → API blocks (asynchronous:false)' }
      },
      required:['keyword'],
      examples: [
        { keyword:'Roblox', region:'US', device:'desktop', maxResults:10, searchEngine:'google' }
      ]
    }
  },
  { name: 'get_serp', description:'Get SERP results by ID.', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_serp', description:'Delete a SERP by ID (404 = not found/expired).', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'],
      examples:[{ id:'68ef1d6eb9bf0e3aa64b9614' }]
    } },
  {
    name: 'create_serp_list',
    description: 'Bulk SERP create. Body must contain an array of *valid* SERP requests (we normalize device & region).',
    inputSchema: {
      type:'object',
      properties: {
        requests: { type:'array', items:{ type:'object' }, description:'Each item follows create_serp fields' },
        synchronous: { type:'boolean' }
      },
      required:['requests'],
      examples: [
        { requests: [
          { keyword:'Roblox', region:'US-en', device:'desktop', maxResults:10, searchEngine:'google' },
          { keyword:'Minecraft', region:'GB', device:'mobile', maxResults:20, searchEngine:'google' }
        ]}
      ]
    }
  },
  { name: 'get_serp_list', description:'Bulk read SERPs by IDs (plain array under the hood).', inputSchema:{ type:'object', properties:{ ids:{ type:'array', items:{type:'string'} } }, required:['ids'],
      examples:[{ ids:['68ef1d6eb9bf0e3aa64b9614','68ef1d6eb9bf0e3aa64b9abc'] }]
    } },

  /* Keywords */
  {
    name: 'create_keyword',
    description: 'Create keyword analysis (search volume and/or suggestions).',
    inputSchema: {
      type:'object',
      properties:{
        keywords:{ type:'array', items:{ type:'string' } },
        url:{ type:'string' },
        region:{ type:'string' },
        language:{ type:'string' },
        source:{ type:'string', enum:['google','baidu'], description:'Default: google' },
        searchPartners:{ type:'boolean' },
        suggestions:{ type:'boolean' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] },
        synchronous:{ type:'boolean' }
      },
      examples: [ { keywords:['Roblox'], region:'US', suggestions:false } ]
    }
  },
  { name: 'get_keyword', description:'Get keyword results by ID.', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_keyword', description:'Delete a keyword request by ID (404 = not found/expired).', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  {
    name: 'create_keyword_list',
    description: 'Bulk keyword create (body = array).',
    inputSchema: {
      type:'object',
      properties:{
        requests:{ type:'array', items:{ type:'object' } },
        synchronous:{ type:'boolean' }
      },
      required:['requests'],
      examples: [
        { requests: [
          { keywords:['python async','python threading'], region:'US', language:'en', suggestions:false },
          { keywords:['rust ownership','rust lifetimes'], region:'US', language:'en', suggestions:false }
        ]}
      ]
    }
  },
  { name: 'get_keyword_list', description:'Bulk read Keywords by IDs.', inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'],
      examples:[{ ids:['68effde7b9bf0e07cd7fc1c6'] }]
    } },

  /* Convenience */
  {
    name: 'compare_locations',
    description: 'Compare SERP results across locations (regions can be ISO2 like "US","GB","CA" or numeric ids; we normalize "US-en"→"US").',
    inputSchema: {
      type:'object',
      properties:{
        keyword:{ type:'string' },
        regions:{ type:'array', items:{ type:'string' }, description:'Max ~3 recommended' },
        device:{ type:'string', enum:['desktop','mobile'] },
        searchEngine:{ type:'string' },
        maxResults:{ type:'number', minimum:10 },
        language:{ type:'string' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] }
      },
      required:['keyword','regions'],
      examples: [
        { keyword:'Roblox', regions:['US-en','GB','CA'], device:'desktop', maxResults:10, searchEngine:'google' }
      ]
    }
  },

  /* Official suggestions shortcut */
  {
    name: 'search_keywords',
    description: 'Generate keyword suggestions via GeoRanker (internally hits /keyword/new with suggestions:true).',
    inputSchema: {
      type:'object',
      properties:{
        seed:{ type:'string', description:'Seed keyword' },
        region:{ type:'string', description:'Default US if omitted' },
        language:{ type:'string' },
        limit:{ type:'number', minimum:1, maximum:100, description:'Client-side slice of API suggestions' }
      },
      required:['seed'],
      examples: [ { seed:'digital marketing', region:'US', limit:20 } ]
    }
  },

  /* Aliases commonly used by clients */
  { name: 'bulk_create_serp',    description:'Alias of create_serp_list (we normalize items).',
    inputSchema:{ type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] } },
  { name: 'bulk_get_serp',       description:'Alias of get_serp_list.',
    inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } },
  { name: 'bulk_create_keyword', description:'Alias of create_keyword_list.',
    inputSchema:{ type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] } },
  { name: 'bulk_get_keyword',    description:'Alias of get_keyword_list.',
    inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

/* ───────────────── Handlers ───────────────── */

async function handleCreateSerpList(args) {
  const { requests = [], synchronous = false } = args || {};
  const items = Array.isArray(requests) ? requests : [];
  let mappedDevice = 0, resolvedRegions = 0, clamped = 0;

  const built = await Promise.all(items.map(async (r) => {
    if (r && typeof r === 'object' && 'device' in r) mappedDevice++;
    const beforeRegion = r?.region;
    const beforeMax    = r?.maxResults;
    const payload = await buildSerp(r || {});
    if (beforeRegion !== payload.region && payload.region !== undefined) resolvedRegions++;
    if (beforeMax !== payload.maxResults) clamped++;
    return payload;
  }));

  const job  = await call('/serp/new/list', { method:'POST', data: built });
  const res  = synchronous ? job : { batch_id: job.id || job.batchId || undefined, queued: true, items: items.length };
  const hints = [];
  if (mappedDevice)   hints.push(`mapped "device"→"isMobile" for ${mappedDevice} item(s)`);
  if (resolvedRegions)hints.push(`resolved region for ${resolvedRegions} item(s)`);
  if (clamped)        hints.push(`clamped maxResults to ≥10 for ${clamped} item(s)`);
  return withHint(res, SHOULD_HINT(mappedDevice||resolvedRegions||clamped) ? `posted plain array; ${hints.join('; ')}` : '');
}

async function handleGetSerpList(args) {
  const idsRaw = Array.isArray(args?.ids) ? args.ids : [];
  let coerced = 0;
  const ids = idsRaw.map((x) => {
    const before = x, after = String(x ?? '').trim();
    if (typeof before !== 'string' || before !== after) coerced++;
    return after;
  }).filter(Boolean);
  const out = await call('/serp/list', { method:'POST', data: ids });
  return withHint(out, SHOULD_HINT(coerced) ? `coerced ${coerced} id(s) to string and posted plain array` : '');
}

async function handleCreateKeywordList(args) {
  const { requests = [], synchronous = false } = args || {};
  const items = Array.isArray(requests) ? requests : [];
  let resolvedRegions = 0;

  const built = await Promise.all(items.map(async (r) => {
    const beforeRegion = r?.region;
    const payload = await buildKeyword(r || {});
    if (beforeRegion !== payload.region && payload.region !== undefined) resolvedRegions++;
    return payload;
  }));

  const job = await call('/keyword/new/list', { method:'POST', data: built });
  const res = synchronous ? job : { batch_id: job.id || job.batchId || undefined, queued: true, items: items.length };
  return withHint(res, SHOULD_HINT(resolvedRegions) ? `posted plain array; resolved region for ${resolvedRegions} item(s)` : '');
}

async function handleGetKeywordList(args) {
  const idsRaw = Array.isArray(args?.ids) ? args.ids : [];
  let coerced = 0;
  const ids = idsRaw.map((x) => {
    const before = x, after = String(x ?? '').trim();
    if (typeof before !== 'string' || before !== after) coerced++;
    return after;
  }).filter(Boolean);
  const out = await call('/keyword/list', { method:'POST', data: ids });
  return withHint(out, SHOULD_HINT(coerced) ? `coerced ${coerced} id(s) to string and posted plain array` : '');
}

async function handleDeleteSerp(args) {
  const id = String(args?.id ?? '').trim();
  if (!id) throw new Error('Missing id');
  const out = await call(`/serp/${encodeURIComponent(id)}`, { method:'DELETE' });
  return withHint(out, SHOULD_HINT(true) ? 'normalized id (trim+encode)' : '');
}

async function handleDeleteKeyword(args) {
  const id = String(args?.id ?? '').trim();
  if (!id) throw new Error('Missing id');
  const out = await call(`/keyword/${encodeURIComponent(id)}`, { method:'DELETE' });
  return withHint(out, SHOULD_HINT(true) ? 'normalized id (trim+encode); 404 may mean expired/unknown id' : '');
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      /* System */
      case 'heartbeat':       return { content: txt(await call('/heartbeat')) };
      case 'get_user':        return { content: txt(await call('/user')) };

      /* Regions */
      case 'list_regions': {
        const params = { apikey: API_KEY };
        if (args?.countryCode) params['countryCode'] = args.countryCode;
        if (args?.type)        params['type']        = args.type;
        return { content: txt(await http.get('/region/list', { params }).then(r=>r.data)) };
      }

      /* Intelligence */
      case 'get_whois':        return { content: txt(await call(`/whois/${encodeURIComponent(args.domain)}`)) };
      case 'get_technologies': return { content: txt(await call(`/technologies/${encodeURIComponent(args.domain)}`)) };

      /* SERP single */
      case 'create_serp': {
        const { synchronous = false, ...body } = args || {};
        const payload = await buildSerp(body);
        const job = await call('/serp/new', { method:'POST', data:{ ...payload, ...(synchronous ? { asynchronous:false } : {}) } });
        if (synchronous) return { content: txt(job) }; // API already waited
        return { content: txt({ job_id: job.id, queued: true }) };
      }
      case 'get_serp':        return { content: txt(await call(`/serp/${args.id}`)) };
      case 'delete_serp':     return { content: await handleDeleteSerp(args) };

      /* SERP bulk */
      case 'create_serp_list': return { content: await handleCreateSerpList(args) };
      case 'get_serp_list':    return { content: await handleGetSerpList(args) };

      /* Keywords single */
      case 'create_keyword': {
        const { synchronous = false, ...rest } = args || {};
        const payload = await buildKeyword(rest);
        const job = await call('/keyword/new', { method:'POST', data:{ ...payload, ...(synchronous ? { asynchronous:false } : {}) } });
        if (synchronous) return { content: txt(job) };
        return { content: txt({ job_id: job.id, queued: true }) };
      }
      case 'get_keyword':    return { content: txt(await call(`/keyword/${args.id}`)) };
      case 'delete_keyword': return { content: await handleDeleteKeyword(args) };

      /* Keywords bulk */
      case 'create_keyword_list': return { content: await handleCreateKeywordList(args) };
      case 'get_keyword_list':    return { content: await handleGetKeywordList(args) };

      /* Compare */
      case 'compare_locations': {
        const { keyword, regions, device='desktop', searchEngine, maxResults, language, priority='NORMAL' } = args || {};
        const limit = pLimit(3);
        const results = await Promise.all((regions||[]).map(raw => limit(async () => {
          try {
            const payload = await buildSerp({
              keyword,
              region: raw,
              device,
              searchEngine: searchEngine ?? 'google',
              maxResults: maxResults ?? 10,
              language,
              priority
            });
            const job = await call('/serp/new', { method:'POST', data: payload });
            return { region: raw, ...(await pollReady(`/serp/${job.id}`)) };
          } catch (e) {
            return { region: raw, error: e.message };
          }
        })));
        return { content: txt({ keyword, device, searchEngine: searchEngine ?? 'google', maxResults: maxResults ?? 10, priority, results }) };
      }

      /* Official suggestions via keyword/new (suggestions:true) */
      case 'search_keywords': {
        const { seed, region='US', language, limit=20 } = args || {};
        const payload = await buildKeyword({
          keywords: [seed],
          region,
          language,
          source: 'google',
          suggestions: true
        });
        const job = await call('/keyword/new', { method:'POST', data:{ ...payload, asynchronous:false } });
        const suggestions = Array.isArray(job?.data?.suggestions) ? job.data.suggestions.slice(0, limit) : [];
        return { content: txt({ seed, suggestions, meta: { from:'GeoRanker API' } }) };
      }

      /* Aliases */
      case 'bulk_create_serp':     return { content: await handleCreateSerpList(args) };
      case 'bulk_get_serp':        return { content: await handleGetSerpList(args) };
      case 'bulk_create_keyword':  return { content: await handleCreateKeywordList(args) };
      case 'bulk_get_keyword':     return { content: await handleGetKeywordList(args) };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { content: txt({ error: error.message }), isError: true };
  }
});

/* ───────────────── Startup ───────────────── */
(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`✅ GeoRanker MCP v1.5.23 ready${VERBOSE ? ' (verbose)' : ''}`);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
