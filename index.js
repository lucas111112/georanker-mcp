/*  GeoRanker MCP Server – v1.5.2  (October‑2025)
    • API parity: bulk endpoints, deletes, official suggestions
    • Fixed maxResults constraints + proper synchronous handling
    • Improved retries (429) and added list_regions tool
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

const http = axios.create({
  baseURL : API_BASE,
  timeout : 30_000,
  headers : { 'User-Agent':'GeoRanker-MCP/1.5.2', 'Content-Type':'application/json' },
  httpsAgent: new HttpsAgent({ keepAlive:true, maxSockets:64 })
});

axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  // Retry network errors, 5xx, and the documented "Too Many Requests"
  retryCondition: (err) => {
    const s = err?.response?.status;
    return axiosRetry.isNetworkOrIdempotentRequestError(err) || s === 429 || s === 502 || s === 504;
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
 *  - "ChI..." (kept as-is if you insist, though canonical strings are preferred)
 *  - ISO2 like "US" / "GB"
 *  - canonical or formatted region names (e.g., "London,England,United Kingdom")
 * Returns one of:
 *  - number (id),
 *  - canonical/formatted string,
 *  - or undefined if not resolvable
 */
async function resolveRegion (input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number')  return input;
  if (/^\d+$/.test(input))        return Number(input);
  if (/^ChI/.test(input))         return input; // kept for backwards compat

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

async function buildSerp (p) {
  const loc      = parseLoc(p.region);
  const region   = await resolveRegion(p.region ?? loc.regionCode);
  return {
    keyword : p.keyword,
    ...(region !== undefined ? { region } : {}),
    ...(p.language||loc.language ? { language:p.language||loc.language } : {}),
    ...(p.searchEngine ? { searchEngine:p.searchEngine } : {}),
    ...(p.maxResults   ? { maxResults : p.maxResults }  : {}),
    ...(p.priority     ? { priority   : p.priority }    : {}),
    ...(p.device ? { isMobile: p.device === 'mobile' } :
       (p.isMobile !== undefined ? { isMobile:p.isMobile } : {})),
    ...(p.saveRawData ? { saveRawData: !!p.saveRawData } : {}),
    ...(p.customUserAgent ? { customUserAgent: p.customUserAgent } : {}),
    ...(p.customUrlParameter ? { customUrlParameter: p.customUrlParameter } : {}),
    ...(p.customCookieParameter ? { customCookieParameter: p.customCookieParameter } : {}),
    ...(p.voiceSearchHighFidelity ? { voiceSearchHighFidelity: !!p.voiceSearchHighFidelity } : {})
  };
}

async function buildKeyword (base) {
  const loc      = parseLoc(base.region);
  const region   = await resolveRegion(base.region ?? loc.regionCode);
  const out = {
    ...(Array.isArray(base.keywords) ? { keywords: base.keywords } : {}),
    ...(base.url ? { url: base.url } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(base.language||loc.language ? { language: base.language||loc.language } : {}),
    ...(base.source ? { source: base.source } : {}), // "google" (default) | "baidu"
    ...(base.searchPartners !== undefined ? { searchPartners: !!base.searchPartners } : {}),
    ...(base.suggestions !== undefined ? { suggestions: !!base.suggestions } : {}),
    ...(base.priority ? { priority: base.priority } : {}),
  };
  return out;
}

/* ───────────────── HTTP small helpers ───────────────── */

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

/** Polls /serp/{id} or /keyword/{id} until ready (unless timeout) */
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
  version: '1.5.2'
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
  throw new Error(`Unknown resource: ${uri}`);
});

// Tools
const tools = [
  { name: 'heartbeat',        description: 'Check GeoRanker API status', inputSchema:{ type:'object', properties:{} } },
  { name: 'get_user',         description: 'Get current user information', inputSchema:{ type:'object', properties:{} } },
  {
    name: 'list_regions',
    description: 'List regions (static; safe to cache 24h)',
    inputSchema: {
      type:'object',
      properties: {
        countryCode: { type:'string', description:'ISO-3166-1 alpha-2, e.g., US' },
        type: { type:'string', description:'Region type filter' }
      }
    }
  },
  {
    name: 'get_whois',
    description: 'Get WHOIS information for a domain',
    inputSchema: { type:'object', properties:{ domain:{ type:'string' } }, required:['domain'] }
  },
  {
    name: 'get_technologies',
    description: 'Get technologies used by a domain',
    inputSchema: { type:'object', properties:{ domain:{ type:'string' } }, required:['domain'] }
  },
  /* SERP */
  {
    name: 'create_serp',
    description: 'Create a SERP (Search Engine Results Page) analysis',
    inputSchema: {
      type:'object',
      properties:{
        keyword:{ type:'string' },
        region:{ type:'string', description:'Canonical region, ISO2, numeric ID, or "US-en" style' },
        language:{ type:'string' },
        searchEngine:{ type:'string', description:'e.g., google, bing, yahoo, amazon, yelp, naver, naverwebdocs' },
        maxResults:{ type:'number', minimum:10, description:'Min 10; upper bound depends on engine/plan' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] },
        device:{ type:'string', enum:['desktop','mobile'] },
        isMobile:{ type:'boolean' },
        saveRawData:{ type:'boolean' },
        customUserAgent:{ type:'string' },
        customUrlParameter:{ type:'array', items:{ type:'object', properties:{ name:{type:'string'}, value:{type:['string','null']}}, required:['name']}},
        customCookieParameter:{ type:'array', items:{ type:'object', properties:{ name:{type:'string'}, value:{type:['string','null']}}, required:['name']}},
        voiceSearchHighFidelity:{ type:'boolean' },
        synchronous:{ type:'boolean', description:'If true, server will block (asynchronous:false) up to ~300s' }
      },
      required:['keyword']
    }
  },
  { name: 'get_serp', description:'Get SERP results by ID', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_serp', description:'Delete a SERP by ID', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  {
    name: 'create_serp_list',
    description: 'Create up to 1000 SERP requests from a list (body = array)',
    inputSchema: {
      type:'object',
      properties: {
        requests: { type:'array', items:{ type:'object' }, description:'Each item follows create_serp fields' },
        synchronous: { type:'boolean' }
      },
      required:['requests']
    }
  },
  { name: 'get_serp_list', description:'Read multiple SERPs by IDs', inputSchema:{ type:'object', properties:{ ids:{ type:'array', items:{type:'string'} } }, required:['ids'] } },

  /* Keywords */
  {
    name: 'create_keyword',
    description: 'Create keyword analysis (search volume and/or suggestions)',
    inputSchema: {
      type:'object',
      properties:{
        keywords:{ type:'array', items:{ type:'string' } },
        url:{ type:'string', description:'Optional URL to derive suggestions' },
        region:{ type:'string' },
        language:{ type:'string' },
        source:{ type:'string', enum:['google','baidu'], description:'Default: google' },
        searchPartners:{ type:'boolean' },
        suggestions:{ type:'boolean' },
        priority:{ type:'string', enum:['LOW','NORMAL','REALTIME','INSTANT'] },
        synchronous:{ type:'boolean' }
      }
    }
  },
  { name: 'get_keyword', description:'Get keyword results by ID', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  { name: 'delete_keyword', description:'Delete a keyword request by ID', inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] } },
  {
    name: 'create_keyword_list',
    description: 'Create up to 1000 keyword requests (body = array)',
    inputSchema: {
      type:'object',
      properties:{
        requests:{ type:'array', items:{ type:'object' } },
        synchronous:{ type:'boolean' }
      },
      required:['requests']
    }
  },
  { name: 'get_keyword_list', description:'Read multiple Keywords by IDs', inputSchema:{ type:'object', properties:{ ids:{type:'array', items:{type:'string'}} }, required:['ids'] } },

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
        language:{ type:'string' }
      },
      required:['keyword','regions']
    }
  },

  /* Official suggestions (replaces local generator) */
  {
    name: 'search_keywords',
    description: 'Generate keyword suggestions via GeoRanker API (official)',
    inputSchema: {
      type:'object',
      properties:{
        seed:{ type:'string', description:'Seed keyword' },
        region:{ type:'string', description:'Default US if omitted' },
        language:{ type:'string' },
        limit:{ type:'number', minimum:1, maximum:100, description:'Client-side slice of API suggestions' }
      },
      required:['seed']
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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

      /* SERP */
      case 'create_serp': {
        const { synchronous = false, ...body } = args || {};
        const payload = await buildSerp(body);
        // API recommendation: synchronous => asynchronous:false (blocks up to ~300s on REALTIME/INSTANT)
        const job = await call('/serp/new', { method:'POST', data:{ ...payload, ...(synchronous ? { asynchronous:false } : {}) } });
        if (synchronous) return { content: txt(job) }; // API already waited
        return { content: txt({ job_id: job.id, queued: true }) };
      }
      case 'get_serp':        return { content: txt(await call(`/serp/${args.id}`)) };
      case 'delete_serp':     return { content: txt(await call(`/serp/${args.id}`, { method:'DELETE' })) };
      case 'create_serp_list': {
        const { requests = [], synchronous = false } = args || {};
        // Body must be a JSON array
        const job = await call('/serp/new/list', { method:'POST', data: requests });
        if (synchronous) return { content: txt(job) };
        return { content: txt({ batch_id: job.id || job.batchId || undefined, queued: true, items: requests.length }) };
      }
      case 'get_serp_list': {
        const ids = Array.isArray(args?.ids) ? args.ids : [];
        return { content: txt(await call('/serp/list', { method:'POST', data: ids })) };
      }

      /* Keywords */
      case 'create_keyword': {
        const { synchronous = false, ...rest } = args || {};
        const payload = await buildKeyword(rest);
        const job = await call('/keyword/new', { method:'POST', data:{ ...payload, ...(synchronous ? { asynchronous:false } : {}) } });
        if (synchronous) return { content: txt(job) };
        return { content: txt({ job_id: job.id, queued: true }) };
      }
      case 'get_keyword':    return { content: txt(await call(`/keyword/${args.id}`)) };
      case 'delete_keyword': return { content: txt(await call(`/keyword/${args.id}`, { method:'DELETE' })) };
      case 'create_keyword_list': {
        const { requests = [], synchronous = false } = args || {};
        // Body must be a JSON array
        const job = await call('/keyword/new/list', { method:'POST', data: requests });
        if (synchronous) return { content: txt(job) };
        return { content: txt({ batch_id: job.id || job.batchId || undefined, queued: true, items: requests.length }) };
      }
      case 'get_keyword_list': {
        const ids = Array.isArray(args?.ids) ? args.ids : [];
        return { content: txt(await call('/keyword/list', { method:'POST', data: ids })) };
      }

      /* Compare */
      case 'compare_locations': {
        const { keyword, regions, device='desktop', searchEngine, maxResults, language } = args || {};
        const limit = pLimit(3);
        const results = await Promise.all(regions.map(raw => limit(async () => {
          const loc = parseLoc(raw);
          const region = await resolveRegion(raw ?? loc.regionCode);
          try {
            const job = await call('/serp/new', {
              method:'POST',
              data:{
                keyword,
                ...(region !== undefined ? { region } : {}),
                ...(language ? { language } : {}),
                ...(searchEngine ? { searchEngine } : {}),
                ...(maxResults ? { maxResults } : {}),
                isMobile: device === 'mobile'
              }
            });
            return { region: raw, ...(await pollReady(`/serp/${job.id}`)) };
          } catch (e) {
            return { region: raw, error: e.message };
          }
        })));
        return { content: txt({ keyword, device, searchEngine, maxResults, results }) };
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
  console.error(`✅ GeoRanker MCP v1.5.2 ready${VERBOSE ? ' (verbose)' : ''}`);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
