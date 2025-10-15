/*  GeoRanker MCP Server – v1.5.22  (October‑2025)
    • Fix “Bad input parameter”: normalize SERP payloads (keyword, isMobile, maxResults≥10, defaults)
    • Bulk ops: build & validate each item then post plain arrays
    • Deletes: trim+encode id
    • Retries: include 500/502/504/429
    • Smart Hints: minimal, only when auto-correcting input (GR_HINTS=off to disable)
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

/* ---------- argv parser (apikey) ---------- */
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
  headers : { 'User-Agent':'GeoRanker-MCP/1.5.22', 'Content-Type':'application/json' },
  httpsAgent: new HttpsAgent({ keepAlive:true, maxSockets:64 })
});
axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) => {
    const s = err?.response?.status;
    return axiosRetry.isNetworkOrIdempotentRequestError(err) || s === 429 || s === 500 || s === 502 || s === 504;
  }
});

const VERBOSE = !!process.env.GR_VERBOSE || process.argv.includes('--verbose');
const vLog    = (...a) => VERBOSE && console.error('[GR-DEBUG]', ...a);

/* ───────────────── Regions (24h cache) ───────────────── */
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

async function resolveRegion (input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number')  return input;
  if (/^\d+$/.test(input))        return Number(input);
  if (/^ChI/.test(input))         return input; // Google Place ID kept as-is

  const txt   = String(input);
  const parts = txt.split(/[-_]/);
  let cc      = parts[0].toUpperCase();
  cc          = REGION_ALIASES[cc] || cc;
  const tail  = parts.slice(1).join(' ').trim();

  const regions = await loadRegions();
  if (!regions.length) return undefined;

  if (tail) {
    const hit = regions.find(r =>
      (r.code===cc||r.countryCode===cc) &&
      (norm(r.canonicalName).includes(norm(tail)) ||
       norm(r.formattedName).includes(norm(tail))));
    if (hit) return Number(hit.id) || hit.canonicalName || hit.formattedName;
  }
  if (parts.length === 1 && cc.length === 2) {
    const hit = regions.find(r => r.code === cc);
    if (hit) return Number(hit.id) || hit.code;
  }
  const nameHit = regions.find(r => norm(r.canonicalName) === norm(txt) ||
                                    norm(r.formattedName) === norm(txt));
  return nameHit ? (Number(nameHit.id) || nameHit.canonicalName || nameHit.formattedName) : undefined;
}

function parseLoc (raw) {
  if (!raw) return {};
  const [cc, maybeLang] = String(raw).split(/[-_]/);
  return {
    regionCode: cc?.toUpperCase(),
    language  : (maybeLang && /^[a-z]{2}$/i.test(maybeLang)) ? maybeLang.toLowerCase() : undefined
  };
}

/* ───────────────── Builders ───────────────── */
const txt = o => [{ type: 'text', text: JSON.stringify(o, null, 2) }];

function withHint(result, hint) {
  if (!hint) return txt(result);
  return [...txt(result), { type: 'text', text: `💡 Hint: ${hint}` }];
}

const clampInt = (v, min, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
};

async function buildSerp (p) {
  const keyword = String(p?.keyword ?? '').trim();
  if (!keyword) throw new Error('Bad input: "keyword" is required and must be non-empty');

  const loc      = parseLoc(p.region);
  const region   = await resolveRegion(p.region ?? loc.regionCode);

  const maxNorm  = clampInt(p.maxResults ?? 10, 10, 100); // enforce ≥10 (API rejects smaller)
  const priority = ['LOW','NORMAL','REALTIME','INSTANT'].includes(p.priority) ? p.priority : 'NORMAL';
  const engine   = (p.searchEngine ?? 'google');

  return {
    keyword,
    ...(region !== undefined ? { region } : {}),
    ...(p.language||loc.language ? { language:p.language||loc.language } : {}),
    searchEngine: engine,
    ...(maxNorm !== undefined ? { maxResults: maxNorm } : {}),
    priority,
    ...(p.device ? { isMobile: p.device === 'mobile' } :
       (p.isMobile !== undefined ? { isMobile: !!p.isMobile } : {})),
    ...(p.saveRawData ? { saveRawData: !!p.saveRawData } : {}),
    ...(p.customUserAgent ? { customUserAgent: p.customUserAgent } : {})
    // NOTE: Only include advanced fields if explicitly provided by client to avoid param validator issues
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

/* ───────────────── HTTP helpers ───────────────── */
async function call (path, opts={}) {
  try {
    if (VERBOSE && opts.data) vLog('REQUEST', path, '\n', JSON.stringify(opts.data,null,2));
    return (await http.request({ url:path, params:{apikey:API_KEY}, ...opts })).data;
  } catch (e) {
    const {status, data} = e.response||{};
    vLog('RESPONSE-ERR', {status, data, payload:opts.data});
    throw new Error(`API ${status||''}: ${typeof data==='string'?data:data?.message||'Unknown error'}`);
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
const server = new Server({ name: 'GeoRanker', version: '1.5.22' }, { capabilities: { tools: {}, resources: {} } });

/* Resources */
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
      description: 'Payload shapes & priorities',
      mimeType: 'text/markdown'
    }
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'georanker://regions') {
    const regions = await loadRegions();
    return { contents: [{ uri, mimeType:'application/json', text: JSON.stringify(regions, null, 2) }] };
  }
  if (uri === 'georanker://help') {
    const help = [
      '# GeoRanker MCP – Quick Reference',
      '',
      '**SERP**',
      '- Single create: POST /serp/new; bulk: POST /serp/new/list (body = array).',
      '- Use `isMobile` (boolean). If you send `device:"mobile"`, MCP maps it.',
      '- `maxResults` ≥ 10; defaulted to 10 if omitted.',
      '',
      '**Keyword**',
      '- Single: POST /keyword/new; bulk: POST /keyword/new/list (body = array).',
      '- Suggestions: `suggestions:true` on /keyword/new (API can block up to ~300s if `asynchronous:false`).',
      '',
      '**Bulk GET**',
      '- /serp/list and /keyword/list expect **plain array of string IDs**.',
      '',
      '**Delete**',
      '- DELETE /serp/{id}, /keyword/{id}; 404 may mean expired/unknown id.',
    ].join('\n');
    return { contents: [{ uri, mimeType:'text/markdown', text: help }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

/* Tools */
const tools = [
  { name: 'heartbeat',  description: 'Check GeoRanker API status',           inputSchema:{ type:'object', properties:{} } },
  { name: 'get_user',   description: 'Get current user information',         inputSchema:{ type:'object', properties:{} } },
  {
    name: 'list_regions',
    description: 'List regions (static; safe to cache 24h)',
    inputSchema: { type:'object', properties: {
      countryCode: { type:'string', description:'ISO2 country code' },
      type:        { type:'string', description:'Region type filter' }
    } }
  },
  { name: 'get_whois',        description: 'WHOIS information',             inputSchema:{ type:'object', properties:{ domain:{type:'string'} }, required:['domain'] } },
  { name: 'get_technologies', description: 'Tech stack for a domain',       inputSchema:{ type:'object', properties:{ domain:{type:'string'} }, required:['domain'] } },

  /* SERP */
  {
    name: 'create_serp',
    description: 'Create a SERP request',
    inputSchema: {
      type:'object',
      properties:{
        keyword:{ type:'string' },
        region:{ type:'string', description:'Canonical region, ISO2, numeric ID, or "US-en"' },
        language:{ type:'string' },
        searchEngine:{ type:'string', description:'e.g., google (default), bing, yahoo, etc.' },
        maxResults:{ type:'number', minimum:10, description:'Min 10; upper bound depends on engine/plan' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] },
        device:{ type:'string', enum:['desktop','mobile'] },
        isMobile:{ type:'boolean' },
        saveRawData:{ type:'boolean' },
        customUserAgent:{ type:'string' },
        synchronous:{ type:'boolean', description:'If true, API waits (asynchronous:false) up to ~300s' }
      },
      required:['keyword']
    }
  },
  { name: 'get_serp',        description:'Get SERP by ID',          inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_serp',     description:'Delete SERP by ID',       inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  {
    name: 'create_serp_list',
    description: 'Bulk: create SERPs (body = array)',
    inputSchema: { type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] }
  },
  { name: 'get_serp_list',   description:'Bulk: get SERPs by IDs',  inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } },

  /* Keywords */
  {
    name: 'create_keyword',
    description: 'Create keyword analysis',
    inputSchema: {
      type:'object',
      properties:{
        keywords:{ type:'array', items:{ type:'string' } },
        url:{ type:'string' },
        region:{ type:'string' },
        language:{ type:'string' },
        source:{ type:'string', enum:['google','baidu'] },
        searchPartners:{ type:'boolean' },
        suggestions:{ type:'boolean' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] },
        synchronous:{ type:'boolean' }
      }
    }
  },
  { name: 'get_keyword',      description:'Get keyword by ID',      inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_keyword',   description:'Delete keyword by ID',   inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  {
    name: 'create_keyword_list',
    description: 'Bulk: create Keywords (body = array)',
    inputSchema: { type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] }
  },
  { name: 'get_keyword_list', description:'Bulk: get Keywords by IDs', inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } },

  /* Convenience */
  {
    name: 'compare_locations',
    description: 'Compare SERP results across locations',
    inputSchema: {
      type:'object',
      properties:{
        keyword:{ type:'string' },
        regions:{ type:'array', items:{ type:'string' }, description:'List of regions to compare (max ~3)' },
        device:{ type:'string', enum:['desktop','mobile'] },
        searchEngine:{ type:'string' },
        maxResults:{ type:'number', minimum:10 },
        language:{ type:'string' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] }
      },
      required:['keyword','regions']
    }
  },

  /* Aliases to match common client names */
  { name: 'bulk_create_serp',    description:'Alias of create_serp_list',    inputSchema:{ type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] } },
  { name: 'bulk_get_serp',       description:'Alias of get_serp_list',       inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } },
  { name: 'bulk_create_keyword', description:'Alias of create_keyword_list', inputSchema:{ type:'object', properties:{ requests:{type:'array', items:{type:'object'}}, synchronous:{type:'boolean'} }, required:['requests'] } },
  { name: 'bulk_get_keyword',    description:'Alias of get_keyword_list',    inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

/* Shared handlers */
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

/* Dispatcher */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'heartbeat':       return { content: txt(await call('/heartbeat')) };
      case 'get_user':        return { content: txt(await call('/user')) };

      case 'list_regions': {
        const params = { apikey: API_KEY };
        if (args?.countryCode) params['countryCode'] = args.countryCode;
        if (args?.type)        params['type']        = args.type;
        return { content: txt(await http.get('/region/list', { params }).then(r=>r.data)) };
      }

      case 'get_whois':        return { content: txt(await call(`/whois/${encodeURIComponent(args.domain)}`)) };
      case 'get_technologies': return { content: txt(await call(`/technologies/${encodeURIComponent(args.domain)}`)) };

      /* SERP single */
      case 'create_serp': {
        const { synchronous = false, ...body } = args || {};
        const payload = await buildSerp(body);
        const job = await call('/serp/new', { method:'POST', data:{ ...payload, ...(synchronous ? { asynchronous:false } : {}) } });
        if (synchronous) return { content: txt(job) }; // API waited (docs mention blocking when asynchronous:false). :contentReference[oaicite:1]{index=1}
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

      /* Compare convenience */
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
  console.error(`✅ GeoRanker MCP v1.5.22 ready${VERBOSE ? ' (verbose)' : ''}`);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
