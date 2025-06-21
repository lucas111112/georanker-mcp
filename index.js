/*  GeoRanker MCP Server – v1.5.1  (June‑2025)
    • Updated for @modelcontextprotocol/sdk v0.5.0
    • Fixed import paths and server initialization
------------------------------------------------------------------------ */
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
import { z } from 'zod';
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
  headers : { 'User-Agent':'GeoRanker-MCP/1.5.1', 'Content-Type':'application/json' },
  httpsAgent: new HttpsAgent({ keepAlive:true, maxSockets:64 })
});
axiosRetry(http, { retries:3, retryDelay:axiosRetry.exponentialDelay });

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

async function resolveRegion (input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'number')  return input;
  if (/^\d+$/.test(input))        return Number(input);
  if (/^ChI/.test(input))         return input;

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
    if (hit) return Number(hit.id);
  }
  if (parts.length === 1 && cc.length === 2) {
    const hit = regions.find(r => r.code === cc);
    if (hit) return Number(hit.id);
  }
  const nameHit = regions.find(r => norm(r.canonicalName) === norm(txt) ||
                                    norm(r.formattedName) === norm(txt));
  return nameHit ? Number(nameHit.id) : undefined;
}

function parseLoc (raw) {
  if (!raw) return {};
  const [cc, maybeLang] = String(raw).split(/[-_]/);
  return {
    regionCode: cc.toUpperCase(),
    language  : (maybeLang && /^[a-z]{2}$/i.test(maybeLang)) ? maybeLang.toLowerCase() : undefined
  };
}

/* ───────────────── Builders ───────────────── */

const txt = o => [{ type: 'text', text: JSON.stringify(o, null, 2) }];

async function buildSerp (p) {
  const loc      = parseLoc(p.region);
  const regionId = await resolveRegion(loc.regionCode);
  return {
    keyword : p.keyword,
    ...(regionId ? { region: regionId } : {}),
    ...(p.language||loc.language ? { language:p.language||loc.language } : {}),
    ...(p.searchEngine ? { searchEngine:p.searchEngine } : {}),
    ...(p.maxResults   ? { maxResults : p.maxResults }  : {}),
    ...(p.priority     ? { priority   : p.priority }    : {}),
    ...(p.isMobile !== undefined ? { isMobile:p.isMobile } : {})
  };
}

async function buildKw (base, list) {
  const loc      = parseLoc(base.region);
  const regionId = await resolveRegion(loc.regionCode);
  return {
    keywords    : list,
    suggestions : base.suggestions ?? false,
    ...(regionId ? { region: regionId } : {}),
    ...(base.language||loc.language ? { language:base.language||loc.language } : {})
  };
}

/* ───────────────── HTTP ───────────────── */

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
  const isFast = /priority=(REALTIME|INSTANT)/.test(path);
  let delay    = isFast ? 2_500 : 5_000;
  const t0     = Date.now();
  while (true) {
    const j = await call(path);
    if (j.ready) return j;
    if (Date.now() - t0 > timeout) throw new Error('poll timeout');
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 20_000);
  }
}

/* ───────────────── MCP Server ───────────────── */

const server = new Server({ 
  name: 'GeoRanker', 
  version: '1.5.1' 
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
  {
    name: 'heartbeat',
    description: 'Check GeoRanker API status',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_user',
    description: 'Get current user information',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_whois',
    description: 'Get WHOIS information for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' }
      },
      required: ['domain']
    }
  },
  {
    name: 'get_technologies',
    description: 'Get technologies used by a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' }
      },
      required: ['domain']
    }
  },
  {
    name: 'create_serp',
    description: 'Create a SERP (Search Engine Results Page) analysis',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword' },
        region: { type: 'string', description: 'Region code (e.g., US, GB)' },
        language: { type: 'string', description: 'Language code' },
        searchEngine: { type: 'string', description: 'Search engine' },
        maxResults: { type: 'number', description: 'Maximum results (1-100)' },
        priority: { type: 'string', enum: ['NORMAL','REALTIME','INSTANT','LOW'] },
        isMobile: { type: 'boolean', description: 'Mobile search' },
        synchronous: { type: 'boolean', description: 'Wait for completion' }
      },
      required: ['keyword']
    }
  },
  {
    name: 'get_serp',
    description: 'Get SERP results by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'SERP job ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_keyword',
    description: 'Create keyword analysis',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'List of keywords' },
        region: { type: 'string', description: 'Region code' },
        language: { type: 'string', description: 'Language code' },
        suggestions: { type: 'boolean', description: 'Include suggestions' },
        synchronous: { type: 'boolean', description: 'Wait for completion' }
      },
      required: ['keywords']
    }
  },
  {
    name: 'get_keyword',
    description: 'Get keyword results by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Keyword job ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'compare_locations',
    description: 'Compare SERP results across different locations',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword' },
        regions: { type: 'array', items: { type: 'string' }, description: 'List of regions to compare (max 3)' },
        device: { type: 'string', enum: ['desktop', 'mobile'], description: 'Device type' }
      },
      required: ['keyword', 'regions']
    }
  },
  {
    name: 'search_keywords',
    description: 'Generate keyword suggestions',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Seed keyword' },
        limit: { type: 'number', description: 'Number of suggestions (1-50)', minimum: 1, maximum: 50 }
      },
      required: ['seed']
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case 'heartbeat':
        return { content: txt(await call('/heartbeat')) };
        
      case 'get_user':
        return { content: txt(await call('/user')) };
        
      case 'get_whois':
        return { content: txt(await call(`/whois/${encodeURIComponent(args.domain)}`)) };
        
      case 'get_technologies':
        return { content: txt(await call(`/technologies/${encodeURIComponent(args.domain)}`)) };
        
      case 'create_serp':
        const { synchronous = false, ...serpBody } = args;
        const payload = await buildSerp(serpBody);
        const job = await call('/serp/new', { method: 'POST', data: payload });
        const result = synchronous 
          ? await pollReady(`/serp/${job.id}?priority=${payload.priority || 'NORMAL'}`)
          : { job_id: job.id, queued: true };
        return { content: txt(result) };
          
      case 'get_serp':
        return { content: txt(await call(`/serp/${args.id}`)) };
        
      case 'create_keyword':
        const { keywords, synchronous: kwSync = false, ...kwRest } = args;
        const kwPayload = await buildKw(kwRest, keywords);
        const kwJob = await call('/keyword/new', { method: 'POST', data: kwPayload });
        const kwResult = kwSync 
          ? await pollReady(`/keyword/${kwJob.id}`)
          : { job_id: kwJob.id, queued: true };
        return { content: txt(kwResult) };
          
      case 'get_keyword':
        return { content: txt(await call(`/keyword/${args.id}`)) };
        
      case 'compare_locations':
        const { keyword, regions, device = 'desktop' } = args;
        const limit = pLimit(3);
        const results = await Promise.all(regions.map(raw => limit(async () => {
          const loc = parseLoc(raw);
          const regionId = await resolveRegion(loc.regionCode);
          try {
            const job = await call('/serp/new', {
              method: 'POST',
              data: {
                keyword,
                ...(regionId ? { region: regionId } : {}),
                ...(loc.language ? { language: loc.language } : {}),
                isMobile: device === 'mobile'
              }
            });
            return { region: raw, ...(await pollReady(`/serp/${job.id}`)) };
          } catch (e) {
            return { region: raw, error: e.message };
          }
        })));
        return { content: txt({ keyword, device, results }) };
        
      case 'search_keywords':
        const { seed, limit: kwLimit = 20 } = args;
        const extra = ['tips', 'guide', 'best', 'reviews', 'how to', 'near me', 'cost', 'benefits',
                      'services', 'online', 'free', 'cheap', 'professional', 'top'];
        return { 
          content: txt({
            seed,
            suggestions: [seed, ...extra.map(x => `${seed} ${x}`)].slice(0, kwLimit)
          })
        };
        
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
  console.error(`✅ GeoRanker MCP v1.5.1 ready${VERBOSE ? ' (verbose)' : ''}`);
})();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));