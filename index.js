#!/usr/bin/env node
/**
 * GeoRanker MCP Server
 * - Supports stdio (Claude Desktop, local clients)
 * - Supports Streamable HTTP (recommended for remote clients)
 * - Supports deprecated HTTP+SSE (backwards compatibility)
 *
 * Design goals:
 * - Agent-optimized tool schemas (clear, typed, minimal confusion)
 * - Compact, structured outputs (no LLM summarization; deterministic shaping + truncation)
 * - Large payloads referenced via resource_link (fetch raw JSON via resources when needed)
 *
 * Repo: https://github.com/lucas111112/georanker-mcp
 */

import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import axios from 'axios';
import axiosRetry from 'axios-retry';
import Agent from 'agentkeepalive';
import pLimit from 'p-limit';

import express from 'express';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

import * as z from 'zod/v4';

/** -----------------------------
 * Version
 * ------------------------------*/
const PACKAGE_VERSION = '1.6.0'; // Keep in sync with package.json

/** -----------------------------
 * Config Schema (Smithery-friendly)
 * ------------------------------*/
export const configSchema = z.object({
  georankerApiKey: z.string().min(1).describe(
    'GeoRanker High Volume API key. Get it from your GeoRanker account. Required for all tools that call GeoRanker.'
  ),
  georankerApiBaseUrl: z
    .string()
    .url()
    .default('https://api.highvolume.georanker.com')
    .describe('GeoRanker API base URL. Usually you should not change this.'),
  verbose: z
    .boolean()
    .default(false)
    .describe('Enable verbose server logs (useful for debugging).'),
  outputMode: z
    .enum(['compact', 'standard', 'raw'])
    .default('compact')
    .describe(
      'Default output verbosity. "compact" is optimized for LLM token budgets. "raw" is still truncated and usually links to a raw resource.'
    ),
  maxPreviewItems: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Default number of items to include in result previews (e.g., top SERP results).'),
  maxStringChars: z
    .number()
    .int()
    .min(50)
    .max(5000)
    .default(800)
    .describe('Maximum length for long strings in tool responses (strings are deterministically truncated).'),
  http: z
    .object({
      enabled: z.boolean().default(false).describe('Start an HTTP server instead of stdio transport.'),
      host: z.string().default('127.0.0.1').describe('HTTP bind host (use 127.0.0.1 for local-only).'),
      port: z.number().int().min(1).max(65535).default(3333).describe('HTTP port.'),
      path: z.string().default('/mcp').describe('Streamable HTTP endpoint path (default: /mcp).'),
      enableDeprecatedSse: z
        .boolean()
        .default(true)
        .describe('Also expose deprecated HTTP+SSE endpoints (/sse and /messages) for older clients.'),
      authToken: z
        .string()
        .optional()
        .describe(
          'Optional Bearer token to protect HTTP endpoints (Authorization: Bearer <token>). Leave empty for no auth.'
        ),
      publicUrl: z
        .string()
        .url()
        .optional()
        .describe('Optional public HTTPS URL used in generated server card and OpenAPI spec.'),
    })
    .default({}),
  enableLegacyToolNames: z
    .boolean()
    .default(false)
    .describe('Expose deprecated snake_case tool names in addition to the new georanker.* names.'),
});

/** -----------------------------
 * CLI parsing
 * ------------------------------*/
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[i + 1];
    const take = () => argv[++i];
    if (a === '--apikey' || a === '--api-key') out.georankerApiKey = take();
    else if (a === '--base-url') out.georankerApiBaseUrl = take();
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--transport') out.transport = take(); // stdio|http
    else if (a === '--http') out.transport = 'http';
    else if (a === '--stdio') out.transport = 'stdio';
    else if (a === '--host') out.host = take();
    else if (a === '--port') out.port = Number(take());
    else if (a === '--path') out.path = take();
    else if (a === '--public-url') out.publicUrl = take();
    else if (a === '--auth-token') out.authToken = take();
    else if (a === '--no-sse') out.enableDeprecatedSse = false;
    else if (a === '--legacy' || a === '--enable-legacy-tool-names') out.enableLegacyToolNames = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      // ignore unknown flags but warn
      // eslint-disable-next-line no-console
      console.warn(`[georanker-mcp] Unknown flag: ${a}${next() && !next().startsWith('--') ? ` ${next()}` : ''}`);
      if (next() && !next().startsWith('--')) i++;
    }
  }
  return out;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
GeoRanker MCP Server (${PACKAGE_VERSION})

Usage:
  georanker-mcp [--apikey <key>] [--transport stdio|http] [--host 127.0.0.1] [--port 3333] [--path /mcp]

Common:
  --apikey <key>           GeoRanker API key (or set GEORANKER_API_KEY env var)
  --base-url <url>         Override GeoRanker API base URL (default: https://api.highvolume.georanker.com)
  --verbose                Verbose logging
  --legacy                 Also expose deprecated snake_case tool names (not recommended)

HTTP mode:
  --transport http         Start HTTP server (Streamable HTTP at /mcp by default)
  --host <host>            Bind host (default 127.0.0.1)
  --port <port>            Bind port (default 3333)
  --path <path>            MCP Streamable HTTP path (default /mcp)
  --no-sse                 Disable deprecated HTTP+SSE endpoints (/sse and /messages)
  --auth-token <token>     Require Authorization: Bearer <token> for HTTP endpoints
  --public-url <https://..> Public URL used in server-card.json + OpenAPI (optional)

Examples:
  # Claude Desktop / local stdio:
  GEORANKER_API_KEY=... georanker-mcp

  # Start HTTP server on localhost:
  GEORANKER_API_KEY=... georanker-mcp --transport http --port 3333

  # Start HTTP server with auth token:
  GEORANKER_API_KEY=... MCP_AUTH_TOKEN=secret georanker-mcp --transport http

Docs:
  https://github.com/lucas111112/georanker-mcp
`);
}

/** -----------------------------
 * Logging helpers
 * ------------------------------*/
function createLogger(verbose) {
  const log = (...args) => {
    if (verbose) console.error('[georanker-mcp]', ...args);
  };
  const warn = (...args) => console.error('[georanker-mcp]', ...args);
  return { log, warn };
}

/** -----------------------------
 * Region cache
 * ------------------------------*/
const REGIONS_CACHE_FILE = path.join(os.tmpdir(), 'georanker_regions_cache.json');
const REGIONS_CACHE_TTL_MS = Number(process.env.GR_REGION_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

let regionsCache = null; // array
let regionsCacheLoadedAt = 0;

async function loadRegions(call, logger) {
  const now = Date.now();
  if (regionsCache && now - regionsCacheLoadedAt < REGIONS_CACHE_TTL_MS) return regionsCache;

  // try disk
  try {
    if (fs.existsSync(REGIONS_CACHE_FILE)) {
      const disk = JSON.parse(fs.readFileSync(REGIONS_CACHE_FILE, 'utf8'));
      if (disk?.regions && disk?.timestamp && now - disk.timestamp < REGIONS_CACHE_TTL_MS) {
        regionsCache = disk.regions;
        regionsCacheLoadedAt = disk.timestamp;
        logger.log('Loaded regions from disk cache');
        return regionsCache;
      }
    }
  } catch (e) {
    logger.warn('Failed reading region cache; continuing', e?.message || e);
  }

  // fetch
  const regions = await call('/region/list', { method: 'GET' });
  regionsCache = Array.isArray(regions) ? regions : regions?.regions || regions?.data || [];
  regionsCacheLoadedAt = now;

  try {
    fs.writeFileSync(
      REGIONS_CACHE_FILE,
      JSON.stringify({ timestamp: regionsCacheLoadedAt, regions: regionsCache }),
      'utf8'
    );
  } catch (e) {
    logger.warn('Failed writing region cache', e?.message || e);
  }
  return regionsCache;
}

async function resolveRegion(regionInput, call, logger) {
  if (!regionInput) return null;
  const regions = await loadRegions(call, logger);

  // GeoRanker often accepts region ids or codes, but we'll try to resolve for consistency.
  const byId = regions.find((r) => String(r.id) === String(regionInput));
  if (byId) return byId.id;

  // Support "US-en" legacy format (code-lang) by stripping "-lang" for region id mapping
  const base = String(regionInput).split('-')[0];
  const byCode = regions.find((r) => String(r.code).toUpperCase() === base.toUpperCase());
  if (byCode) return byCode.id;

  // If unknown, pass through as-is (some GeoRanker endpoints accept region codes)
  return regionInput;
}

/** -----------------------------
 * HTTP client (GeoRanker)
 * ------------------------------*/
function createGeoRankerCaller({ apiKey, baseUrl, verbose }) {
  if (!apiKey) throw new Error('Missing GeoRanker API key. Set GEORANKER_API_KEY or pass --apikey.');

  const { HttpsAgent } = Agent;
  const keepAliveHttpAgent = new Agent({ maxSockets: 64, maxFreeSockets: 10, timeout: 60_000, freeSocketTimeout: 30_000 });
  const keepAliveHttpsAgent = new HttpsAgent({ maxSockets: 64, maxFreeSockets: 10, timeout: 60_000, freeSocketTimeout: 30_000 });

  const http = axios.create({
    baseURL: baseUrl,
    headers: { 'X-API-Key': apiKey },
    timeout: 30_000,
    httpAgent: keepAliveHttpAgent,
    httpsAgent: keepAliveHttpsAgent,
    // GeoRanker can return large payloads; avoid implicit JSON transform surprises
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
  });

  axiosRetry(http, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) => {
      const status = err?.response?.status;
      return axiosRetry.isNetworkOrIdempotentRequestError(err) || status === 429 || (status >= 500 && status < 600);
    },
  });

  const call = async (url, config = {}) => {
    const t0 = Date.now();
    try {
      const res = await http.request({ url, ...config });
      if (verbose) console.error('[georanker-mcp]', url, res.status, `${Date.now() - t0}ms`);
      return res.data;
    } catch (err) {
      // Attach status/data for structured errors
      const status = err?.response?.status;
      const data = err?.response?.data;
      err.__mcp = { status, data, url, method: config?.method || 'GET' };
      throw err;
    }
  };

  return { call };
}

/** -----------------------------
 * Deterministic output shaping (no LLM summarization)
 * ------------------------------*/
function omitUndefined(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function safeStringify(value, maxChars = 12000) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    // fallback (e.g., circular)
    json = JSON.stringify({ ok: false, error: { message: 'Failed to serialize output' } });
  }
  if (json.length <= maxChars) return { text: json, truncated: false };
  return {
    text: json.slice(0, Math.max(0, maxChars - 60)) + `…(truncated ${json.length - maxChars} chars)`,
    truncated: true,
  };
}

function pruneJson(value, opts, meta, depth = 0, p = '$') {
  const {
    maxDepth = 6,
    maxArrayItems = 20,
    maxStringChars = 800,
    maxKeys = 100,
    maxMetaPaths = 25,
  } = opts || {};

  const noteTrunc = (pathStr) => {
    meta.truncated = true;
    if (meta.truncatedPaths.length < maxMetaPaths) meta.truncatedPaths.push(pathStr);
  };

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.length > maxStringChars) {
      noteTrunc(p);
      return value.slice(0, maxStringChars) + '…';
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    if (depth >= maxDepth) {
      noteTrunc(p);
      return `[Truncated array depth>${maxDepth}]`;
    }
    const out = [];
    const n = value.length;
    const take = Math.min(n, maxArrayItems);
    for (let i = 0; i < take; i++) {
      out.push(pruneJson(value[i], opts, meta, depth + 1, `${p}[${i}]`));
    }
    if (n > take) {
      noteTrunc(p);
      out.push({ __truncated__: true, __original_length__: n, __kept__: take });
    }
    return out;
  }

  if (typeof value === 'object') {
    if (depth >= maxDepth) {
      noteTrunc(p);
      return `[Truncated object depth>${maxDepth}]`;
    }
    const keys = Object.keys(value);
    const out = {};
    const take = Math.min(keys.length, maxKeys);
    for (let i = 0; i < take; i++) {
      const k = keys[i];
      out[k] = pruneJson(value[k], opts, meta, depth + 1, `${p}.${k}`);
    }
    if (keys.length > take) {
      noteTrunc(p);
      out.__truncated_keys__ = { __original_key_count__: keys.length, __kept__: take };
    }
    return out;
  }

  // bigint, symbol, function etc
  noteTrunc(p);
  return String(value);
}

function toUrlHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
}

function scoreResultItem(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const hasUrl = keys.some((k) => k === 'url' || k === 'link' || k.includes('url'));
  const hasTitle = keys.some((k) => k === 'title' || k === 'name' || k.includes('title'));
  const hasPos = keys.some((k) => k === 'position' || k === 'rank' || k === 'pos');
  return (hasUrl ? 2 : 0) + (hasTitle ? 2 : 0) + (hasPos ? 1 : 0);
}

function pickSerpResultsCandidate(root) {
  // Heuristic scan (bounded) to find the most likely array of SERP result items.
  const maxDepth = 5;
  const queue = [{ v: root, p: '$', d: 0 }];
  let best = null;

  while (queue.length) {
    const { v, p, d } = queue.shift();
    if (d > maxDepth || !v) continue;

    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      // sample first few
      const sample = v.slice(0, Math.min(v.length, 8));
      const score = sample.reduce((acc, it) => acc + scoreResultItem(it), 0) / sample.length;
      if (!best || score > best.score) best = { path: p, score, arr: v };
    } else if (typeof v === 'object') {
      const keys = Object.keys(v);
      for (const k of keys) {
        queue.push({ v: v[k], p: `${p}.${k}`, d: d + 1 });
      }
    }
  }

  return best?.arr || null;
}

function compactSerp(raw, { maxItems = 10 } = {}) {
  const id = raw?.id ?? raw?.job_id ?? raw?.jobId ?? raw?._id;
  const ready = Boolean(raw?.ready ?? raw?.isReady ?? raw?.completed ?? raw?.done);
  const keyword = raw?.keyword ?? raw?.query ?? raw?.q ?? raw?.data?.keyword;
  const region = raw?.region ?? raw?.data?.region ?? raw?.location ?? raw?.data?.location;
  const searchEngine = raw?.searchEngine ?? raw?.search_engine ?? raw?.engine ?? raw?.data?.searchEngine;
  const device = raw?.device ?? raw?.data?.device ?? (raw?.isMobile ? 'mobile' : undefined);

  const dataRoot = raw?.data ?? raw?.result ?? raw;
  const candidate = pickSerpResultsCandidate(dataRoot);
  const total = Array.isArray(candidate) ? candidate.length : 0;

  const preview = Array.isArray(candidate)
    ? candidate.slice(0, Math.min(total, maxItems)).map((item, idx) => {
        const url = item?.url ?? item?.link ?? item?.target ?? item?.destinationUrl ?? item?.destination_url;
        const title = item?.title ?? item?.name ?? item?.heading ?? item?.text ?? item?.headline;
        const snippet =
          item?.snippet ?? item?.description ?? item?.desc ?? item?.summary ?? item?.textSnippet ?? item?.text_snippet;
        const position = item?.position ?? item?.rank ?? item?.pos ?? idx + 1;
        return omitUndefined({
          position,
          title,
          url,
          host: url ? toUrlHost(url) : undefined,
          snippet: typeof snippet === 'string' ? snippet : undefined,
          // keep minimal extra signals
          type: item?.type ?? item?.resultType ?? item?.result_type,
        });
      })
    : [];

  return omitUndefined({
    id,
    ready,
    request: omitUndefined({ keyword, region, searchEngine, device }),
    results: omitUndefined({
      total,
      preview,
      // If we could not confidently find results, mention why
      note: candidate ? undefined : 'No obvious results array found in payload; use raw_resource to inspect full JSON.',
    }),
  });
}

function compactKeyword(raw, { maxItems = 10 } = {}) {
  const id = raw?.id ?? raw?.job_id ?? raw?.jobId ?? raw?._id;
  const ready = Boolean(raw?.ready ?? raw?.isReady ?? raw?.completed ?? raw?.done);
  const region = raw?.region ?? raw?.data?.region;
  const source = raw?.source ?? raw?.data?.source;

  const dataRoot = raw?.data ?? raw?.result ?? raw;

  // Try to find an array of keyword objects
  const candidate = pickSerpResultsCandidate(dataRoot); // reuse heuristic (url/title isn't great, but still finds arrays)
  const arraysToCheck = [];
  if (Array.isArray(dataRoot?.keywords)) arraysToCheck.push(dataRoot.keywords);
  if (Array.isArray(dataRoot?.items)) arraysToCheck.push(dataRoot.items);
  if (Array.isArray(candidate)) arraysToCheck.push(candidate);

  let kwArr = null;
  for (const arr of arraysToCheck) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const item = arr[0];
    if (item && typeof item === 'object') {
      const keys = Object.keys(item).map((k) => k.toLowerCase());
      if (keys.includes('keyword') || keys.includes('query') || keys.includes('phrase')) {
        kwArr = arr;
        break;
      }
    }
  }

  const total = Array.isArray(kwArr) ? kwArr.length : 0;
  const preview = Array.isArray(kwArr)
    ? kwArr.slice(0, Math.min(total, maxItems)).map((k) => {
        const keyword = k.keyword ?? k.query ?? k.phrase ?? k.term;
        const volume = k.searchVolume ?? k.search_volume ?? k.volume ?? k.avgMonthlySearches ?? k.monthly_searches;
        const cpc = k.cpc ?? k.costPerClick ?? k.cost_per_click;
        const competition = k.competition ?? k.comp ?? k.difficulty ?? k.keywordDifficulty ?? k.keyword_difficulty;
        return omitUndefined({ keyword, volume, cpc, competition });
      })
    : [];

  return omitUndefined({
    id,
    ready,
    request: omitUndefined({ region, source }),
    keywords: omitUndefined({
      total,
      preview,
      note: kwArr ? undefined : 'No obvious keyword array found; use raw_resource to inspect full JSON.',
    }),
  });
}

function makeOk({ action, data, request, meta, links }) {
  const out = omitUndefined({
    ok: true,
    action,
    generated_at: new Date().toISOString(),
    request,
    data,
    meta,
    links,
  });
  return out;
}

function makeErr({ action, error, request, hint }) {
  const status = error?.__mcp?.status;
  const code = error?.code;
  const message =
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.message ||
    'Unknown error';

  const retryable = status === 429 || (status >= 500 && status < 600) || code === 'ECONNRESET' || code === 'ETIMEDOUT';

  const out = omitUndefined({
    ok: false,
    action,
    generated_at: new Date().toISOString(),
    request,
    error: omitUndefined({
      message,
      status,
      code,
      retryable,
      details: error?.__mcp?.data ? pruneJson(error.__mcp.data, { maxDepth: 4, maxArrayItems: 10, maxStringChars: 500 }, { truncated: false, truncatedPaths: [] }) : undefined,
    }),
    hint: hint || (retryable ? 'Retry the request after a short delay.' : undefined),
  });
  return out;
}

function toolResultFromObject(obj, { maxToolChars = Number(process.env.GR_MAX_TOOL_CHARS || 12000) } = {}) {
  const { text } = safeStringify(obj, maxToolChars);
  const res = {
    content: [{ type: 'text', text }],
    structuredContent: obj,
  };
  if (obj && typeof obj === 'object' && obj.ok === false) res.isError = true;
  return res;
}


/** -----------------------------
 * Tool schemas (agent-optimized)
 * ------------------------------*/
const DeviceEnum = z.enum(['desktop', 'mobile']).default('desktop').describe('Target device for the SERP.');
const PriorityEnum = z
  .enum(['LOW', 'NORMAL', 'REALTIME', 'INSTANT'])
  .default('NORMAL')
  .describe('Processing priority. Higher priorities may cost more / have stricter rate limits.');

const OutputModeEnum = z
  .enum(['compact', 'standard', 'raw'])
  .default('compact')
  .describe(
    'Output verbosity. "compact" returns a small preview + a raw_resource link. "raw" still truncates and prefers raw_resource.'
  );

const RegionSchema = z
  .string()
  .min(1)
  .describe(
    'Region code or region id. Common values: "US", "GB", "DE". Some setups support "US-NY" or legacy "US-en".'
  );

const UrlSchema = z.string().min(1).describe('A fully qualified URL (including https://) or a hostname.');

const SearchEngineSchema = z
  .string()
  .default('google')
  .describe('Search engine identifier (examples: "google", "bing", "yahoo", "amazon", "yelp", "naver").');

const SerpCreateSchema = {
  keyword: z.string().min(1).describe('Search query / keyword to fetch SERP results for.'),
  region: RegionSchema.describe('Region where the SERP should be geo-located.'),
  language: z.string().optional().describe('Language code (e.g., "en"). If omitted, GeoRanker default is used.'),
  searchEngine: SearchEngineSchema,
  device: DeviceEnum,
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Maximum number of results to request from GeoRanker (server still returns a preview).'),
  priority: PriorityEnum,
  customUrlParameter: z
    .array(
      z.object({
        key: z.string().min(1).describe('Query parameter name.'),
        value: z.string().describe('Query parameter value.'),
      })
    )
    .optional()
    .describe('Optional custom query parameters to append to the request.'),
  customCookieParameter: z
    .array(
      z.object({
        key: z.string().min(1).describe('Cookie name.'),
        value: z.string().describe('Cookie value.'),
      })
    )
    .optional()
    .describe('Optional cookies to send when fetching SERP results.'),
  synchronous: z
    .boolean()
    .default(false)
    .describe('If true, wait for the SERP to be ready and return a compact snapshot (slower).'),
  outputMode: OutputModeEnum.optional(),
};

const SerpGetSchema = {
  id: z.string().min(1).describe('SERP job id from georanker.serp.create.'),
  outputMode: OutputModeEnum.optional(),
  maxPreviewItems: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Override how many results appear in the preview section.'),
};

const SerpListGetSchema = {
  ids: z.array(z.string().min(1)).min(1).max(1000).describe('List of SERP ids to fetch.'),
  outputMode: OutputModeEnum.optional(),
  maxPreviewItems: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Preview size (per SERP) for compact output.'),
};

const KeywordCreateSchema = {
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .describe('One or more keywords to analyze.'),
  region: RegionSchema.describe('Region for keyword metrics (country/region code or id).'),
  source: z.enum(['google', 'baidu']).default('google').describe('Keyword data source.'),
  suggestions: z
    .boolean()
    .default(false)
    .describe('If true, request keyword suggestions in addition to metrics (may increase payload).'),
  url: z
    .string()
    .optional()
    .describe('Optional URL used by GeoRanker to generate domain-related keyword ideas.'),
  priority: PriorityEnum,
  synchronous: z
    .boolean()
    .default(false)
    .describe('If true, wait for the keyword report to be ready and return a compact snapshot (slower).'),
  outputMode: OutputModeEnum.optional(),
};

const KeywordGetSchema = {
  id: z.string().min(1).describe('Keyword report id from georanker.keywords.create.'),
  outputMode: OutputModeEnum.optional(),
  maxPreviewItems: z.number().int().min(1).max(50).optional().describe('Preview size for compact output.'),
};

const KeywordListGetSchema = {
  ids: z.array(z.string().min(1)).min(1).max(1000).describe('List of keyword report ids to fetch.'),
  outputMode: OutputModeEnum.optional(),
  maxPreviewItems: z.number().int().min(1).max(50).optional().describe('Preview size per item.'),
};

const KeywordSuggestSchema = {
  seed: z.string().min(1).describe('Seed keyword to expand into suggestions.'),
  region: RegionSchema.optional().describe('Optional region constraint.'),
  source: z.enum(['google', 'baidu']).default('google').describe('Keyword data source.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max number of suggestions to return.'),
};

const DomainSchema = {
  domain: z
    .string()
    .min(1)
    .describe('Domain name (example: "example.com") or full URL (example: "https://example.com").'),
  outputMode: OutputModeEnum.optional(),
};

const CompareLocationsSchema = {
  keyword: z.string().min(1).describe('Keyword to compare across regions.'),
  regions: z
    .array(RegionSchema)
    .min(2)
    .max(10)
    .describe('2-10 regions to compare. Keep this small to control cost/latency.'),
  language: z.string().optional().describe('Language code (e.g., "en"). Optional.'),
  searchEngine: SearchEngineSchema,
  device: DeviceEnum,
  maxResults: z.number().int().min(1).max(50).default(10).describe('Max results requested per region.'),
  priority: PriorityEnum,
  timeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(10 * 60_000)
    .default(180_000)
    .describe('Max time to wait for all regions to become ready (milliseconds).'),
  outputMode: OutputModeEnum.optional(),
};

/** -----------------------------
 * Internal request builders
 * ------------------------------*/
async function buildSerpRequest(args, call, logger) {
  const {
    keyword,
    region,
    language,
    searchEngine,
    device,
    maxResults = 10,
    priority = 'NORMAL',
    customUrlParameter,
    customCookieParameter,
  } = args;

  const regionId = await resolveRegion(region, call, logger);

  const req = {
    keyword,
    region: regionId,
    language: language ?? undefined,
    searchEngine: searchEngine ?? 'google',
    isMobile: device === 'mobile',
    maxResults,
    priority,
    customUrlParameter,
    customCookieParameter,
  };

  // Drop undefined
  return Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
}

async function buildKeywordRequest(args, call, logger) {
  const { keywords, region, source, suggestions, url, priority = 'NORMAL' } = args;
  const regionId = await resolveRegion(region, call, logger);

  const req = {
    keywords,
    region: regionId,
    source: source ?? 'google',
    suggestions: suggestions ?? false,
    url: url ?? undefined,
    priority,
  };

  return Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
}

async function pollReady(call, path, timeout = 180_000) {
  let delay = 5_000;
  const t0 = Date.now();
  while (true) {
    const j = await call(path, { method: 'GET' });
    if (j?.ready) return j;
    if (Date.now() - t0 > timeout) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 20_000);
  }
}

/** -----------------------------
 * Raw cache (best-effort)
 * ------------------------------*/
const RAW_CACHE_TTL_MS = Number(process.env.GR_RAW_CACHE_TTL_MS || 15 * 60_000);
const rawCache = new Map(); // key -> {ts, data}

function rawCacheGet(key) {
  const entry = rawCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RAW_CACHE_TTL_MS) {
    rawCache.delete(key);
    return null;
  }
  return entry.data;
}

function rawCacheSet(key, data) {
  rawCache.set(key, { ts: Date.now(), data });
}

/** -----------------------------
 * Tool handlers (shared by MCP tools + HTTP API)
 * ------------------------------*/
function createHandlers({ call, logger, defaults }) {
  const maxPreviewDefault = defaults.maxPreviewItems ?? 10;
  const maxStringDefault = defaults.maxStringChars ?? 800;
  const defaultMode = defaults.outputMode ?? 'compact';

  const pruneDefaults = {
    maxDepth: 6,
    maxArrayItems: 20,
    maxStringChars: maxStringDefault,
    maxKeys: 120,
  };

  const shapeRaw = (raw, { maxArrayItems = 20 } = {}) => {
    const meta = { truncated: false, truncatedPaths: [] };
    const pruned = pruneJson(raw, { ...pruneDefaults, maxArrayItems }, meta);
    return { pruned, meta };
  };

  const outputMode = (mode) => mode || defaultMode;

  return {
    async healthCheck() {
      const action = 'georanker.health.check';
      try {
        const raw = await call('/heartbeat', { method: 'GET' });
        rawCacheSet('heartbeat', raw);
        const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 10 });
        return makeOk({
          action,
          data: pruned,
          meta,
        });
      } catch (error) {
        return makeErr({ action, error });
      }
    },

    async accountGet() {
      const action = 'georanker.account.get';
      try {
        const raw = await call('/user', { method: 'GET' });
        rawCacheSet('user', raw);
        const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 10 });
        return makeOk({ action, data: pruned, meta });
      } catch (error) {
        return makeErr({ action, error });
      }
    },

    async regionsList() {
      const action = 'georanker.regions.list';
      try {
        const regions = await loadRegions(call, logger);
        const meta = { truncated: false, truncatedPaths: [] };
        // Regions list can be large; return small preview + resource link
        const preview = regions.slice(0, 50).map((r) => ({ id: r.id, code: r.code, name: r.name }));
        const data = {
          total: regions.length,
          preview,
          note:
            regions.length > preview.length
              ? 'Only a preview is included. Use resource georanker://regions for the full list.'
              : undefined,
          resource: 'georanker://regions',
        };
        return makeOk({ action, data, meta });
      } catch (error) {
        return makeErr({ action, error });
      }
    },

    async domainWhois({ domain, outputMode: mode }) {
      const action = 'georanker.domain.whois';
      const request = { domain };
      try {
        const raw = await call('/whois', { method: 'GET', params: { domain } });
        rawCacheSet(`whois:${domain}`, raw);

        if (outputMode(mode) === 'raw') {
          const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 50 });
          return makeOk({
            action,
            request,
            data: pruned,
            meta,
            links: { raw_resource: `georanker://whois/${encodeURIComponent(domain)}` },
          });
        }

        const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 10 });
        return makeOk({
          action,
          request,
          data: pruned,
          meta,
          links: { raw_resource: `georanker://whois/${encodeURIComponent(domain)}` },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async domainTechnologies({ domain, outputMode: mode }) {
      const action = 'georanker.domain.technologies';
      const request = { domain };
      try {
        const raw = await call('/technologies', { method: 'GET', params: { domain } });
        rawCacheSet(`tech:${domain}`, raw);

        // Try to compact to a list of tech names if possible
        const dataRoot = raw?.data ?? raw?.result ?? raw;
        const techArr =
          (Array.isArray(dataRoot?.technologies) && dataRoot.technologies) ||
          (Array.isArray(dataRoot?.tech) && dataRoot.tech) ||
          (Array.isArray(dataRoot) && dataRoot) ||
          null;

        let compact = null;
        if (Array.isArray(techArr)) {
          const preview = techArr.slice(0, 50).map((t) => {
            const name = t?.name ?? t?.technology ?? t?.title ?? t;
            const category = t?.category ?? t?.group;
            return omitUndefined({ name: typeof name === 'string' ? name : undefined, category });
          });
          compact = {
            total: techArr.length,
            preview,
            note:
              techArr.length > preview.length
                ? 'Only a preview is included. Use raw_resource for full JSON.'
                : undefined,
          };
        }

        if (outputMode(mode) === 'raw' || !compact) {
          const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 50 });
          return makeOk({
            action,
            request,
            data: compact || pruned,
            meta,
            links: { raw_resource: `georanker://technologies/${encodeURIComponent(domain)}` },
          });
        }

        return makeOk({
          action,
          request,
          data: compact,
          meta: { truncated: compact.total > compact.preview.length, truncatedPaths: compact.total > compact.preview.length ? ['$.technologies'] : [] },
          links: { raw_resource: `georanker://technologies/${encodeURIComponent(domain)}` },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpCreate(args) {
      const action = 'georanker.serp.create';
      const request = omitUndefined({ keyword: args.keyword, region: args.region, device: args.device, searchEngine: args.searchEngine });
      const mode = outputMode(args.outputMode);

      try {
        const payload = await buildSerpRequest(args, call, logger);
        const raw = await call('/serp/new', { method: 'POST', data: { ...payload, asynchronous: !args.synchronous } });
        const id = raw?.id ?? raw?.job_id ?? raw?.jobId;

        if (id) rawCacheSet(`serp:${id}`, raw);

        if (!args.synchronous) {
          return makeOk({
            action,
            request,
            data: omitUndefined({
id,
              ready: Boolean(raw?.ready),
              status: raw?.ready ? 'ready' : 'queued',
              next: omitUndefined({
                poll_tool: 'georanker.serp.get',
                poll_args: { id, outputMode: mode },
              }),
}),
            meta: { truncated: false, truncatedPaths: [] },
            links: { raw_resource: id ? `georanker://serp/${id}` : undefined },
          });
        }

        // synchronous: return compact snapshot
        const summary = compactSerp(raw, { maxItems: args.maxResults ?? maxPreviewDefault });
        return makeOk({
          action,
          request,
          data: summary,
          meta: { truncated: false, truncatedPaths: [] },
          links: { raw_resource: id ? `georanker://serp/${id}` : undefined },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpGet({ id, outputMode: mode, maxPreviewItems }) {
      const action = 'georanker.serp.get';
      const request = { id };
      const oMode = outputMode(mode);
      const previewN = maxPreviewItems ?? maxPreviewDefault;

      try {
        const raw = await call(`/serp/${id}`, { method: 'GET' });
        rawCacheSet(`serp:${id}`, raw);

        if (oMode === 'raw') {
          const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 100 });
          return makeOk({
            action,
            request,
            data: pruned,
            meta,
            links: { raw_resource: `georanker://serp/${id}` },
          });
        }

        const summary = compactSerp(raw, { maxItems: previewN });
        const meta = { truncated: false, truncatedPaths: [] };
        return makeOk({
          action,
          request,
          data: summary,
          meta,
          links: { raw_resource: `georanker://serp/${id}` },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpDelete({ id }) {
      const action = 'georanker.serp.delete';
      const request = { id };
      try {
        const raw = await call(`/serp/${id}`, { method: 'DELETE' });
        rawCacheSet(`serp_delete:${id}`, raw);
        const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 10 });
        return makeOk({ action, request, data: pruned, meta });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpBatchCreate({ requests, outputMode: mode }) {
      const action = 'georanker.serp.batch_create';
      const request = { count: requests?.length ?? 0 };
      const oMode = outputMode(mode);

      try {
        if (!Array.isArray(requests) || requests.length === 0) {
          throw new Error('requests must be a non-empty array');
        }
        if (requests.length > 1000) {
          throw new Error('Maximum 1000 requests allowed per batch');
        }

        // Normalize each request (region ids, device -> isMobile, defaults)
        const limit = pLimit(10);
        const built = await Promise.all(
          requests.map((r) =>
            limit(async () =>
              buildSerpRequest(
                {
                  keyword: r.keyword,
                  region: r.region,
                  language: r.language,
                  searchEngine: r.searchEngine ?? r.search_engine ?? 'google',
                  device: r.device ?? (r.isMobile ? 'mobile' : 'desktop'),
                  maxResults: r.maxResults ?? r.max_results ?? 10,
                  priority: r.priority ?? 'NORMAL',
                  customUrlParameter: r.customUrlParameter,
                  customCookieParameter: r.customCookieParameter,
                },
                call,
                logger
              )
            )
          )
        );

        const raw = await call('/serp/new/list', { method: 'POST', data: built });
        // Expect a list of partial SERP objects with ids
        const items = Array.isArray(raw) ? raw : raw?.data || raw?.items || raw?.serps || [];
        const ids = items.map((it) => it?.id).filter(Boolean);
        ids.forEach((id) => rawCacheSet(`serp:${id}`, items.find((x) => x.id === id)));

        const data = omitUndefined({
          count: items.length,
          ids: ids.slice(0, 1000),
          note: items.length !== ids.length ? 'Some returned items were missing ids.' : undefined,
          next: ids.length
            ? {
                poll_tool: 'georanker.serp.batch_get',
                poll_args: { ids: ids.slice(0, 1000), outputMode: oMode },
              }
            : undefined,
        });

        return makeOk({ action, request, data, meta: { truncated: false, truncatedPaths: [] } });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpBatchGet({ ids, outputMode: mode, maxPreviewItems }) {
      const action = 'georanker.serp.batch_get';
      const request = { count: ids?.length ?? 0 };
      const oMode = outputMode(mode);
      const previewN = maxPreviewItems ?? maxPreviewDefault;

      try {
        const raw = await call('/serp/list', { method: 'POST', data: { ids } });
        const list = Array.isArray(raw) ? raw : raw?.data || raw?.items || raw?.serps || [];
        // cache
        for (const it of list) {
          const id = it?.id;
          if (id) rawCacheSet(`serp:${id}`, it);
        }

        if (oMode === 'raw') {
          const { pruned, meta } = shapeRaw(list, { maxArrayItems: 100 });
          return makeOk({ action, request, data: pruned, meta });
        }

        const items = list.map((it) => compactSerp(it, { maxItems: previewN }));
        const readyCount = items.filter((x) => x.ready).length;

        return makeOk({
          action,
          request,
          data: {
            total: items.length,
            ready: readyCount,
            pending: items.length - readyCount,
            items,
          },
          meta: { truncated: false, truncatedPaths: [] },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsCreate(args) {
      const action = 'georanker.keywords.create';
      const request = { count: args.keywords?.length ?? 0, region: args.region, source: args.source };
      const mode = outputMode(args.outputMode);

      try {
        const payload = await buildKeywordRequest(args, call, logger);
        const raw = await call('/keyword/new', { method: 'POST', data: { ...payload, asynchronous: !args.synchronous } });
        const id = raw?.id ?? raw?.job_id ?? raw?.jobId;
        if (id) rawCacheSet(`kw:${id}`, raw);

        if (!args.synchronous) {
          return makeOk({
            action,
            request,
            data: omitUndefined({
              id,
              ready: Boolean(raw?.ready),
              status: raw?.ready ? 'ready' : 'queued',
              next: omitUndefined({
                poll_tool: 'georanker.keywords.get',
                poll_args: { id, outputMode: mode },
              }),
}),
            meta: { truncated: false, truncatedPaths: [] },
            links: { raw_resource: id ? `georanker://keywords/${id}` : undefined },
          });
        }

        const summary = compactKeyword(raw, { maxItems: args.maxPreviewItems ?? maxPreviewDefault });
        return makeOk({
          action,
          request,
          data: summary,
          meta: { truncated: false, truncatedPaths: [] },
          links: { raw_resource: id ? `georanker://keywords/${id}` : undefined },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsGet({ id, outputMode: mode, maxPreviewItems }) {
      const action = 'georanker.keywords.get';
      const request = { id };
      const oMode = outputMode(mode);
      const previewN = maxPreviewItems ?? maxPreviewDefault;

      try {
        const raw = await call(`/keyword/${id}`, { method: 'GET' });
        rawCacheSet(`kw:${id}`, raw);

        if (oMode === 'raw') {
          const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 100 });
          return makeOk({
            action,
            request,
            data: pruned,
            meta,
            links: { raw_resource: `georanker://keywords/${id}` },
          });
        }

        const summary = compactKeyword(raw, { maxItems: previewN });
        return makeOk({
          action,
          request,
          data: summary,
          meta: { truncated: false, truncatedPaths: [] },
          links: { raw_resource: `georanker://keywords/${id}` },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsDelete({ id }) {
      const action = 'georanker.keywords.delete';
      const request = { id };
      try {
        const raw = await call(`/keyword/${id}`, { method: 'DELETE' });
        rawCacheSet(`kw_delete:${id}`, raw);
        const { pruned, meta } = shapeRaw(raw, { maxArrayItems: 10 });
        return makeOk({ action, request, data: pruned, meta });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsBatchCreate({ requests, outputMode: mode }) {
      const action = 'georanker.keywords.batch_create';
      const request = { count: requests?.length ?? 0 };
      const oMode = outputMode(mode);

      try {
        if (!Array.isArray(requests) || requests.length === 0) throw new Error('requests must be a non-empty array');
        if (requests.length > 1000) throw new Error('Maximum 1000 requests allowed per batch');

        const limit = pLimit(10);
        const built = await Promise.all(
          requests.map((r) =>
            limit(async () =>
              buildKeywordRequest(
                {
                  keywords: r.keywords,
                  region: r.region,
                  source: r.source ?? 'google',
                  suggestions: r.suggestions ?? false,
                  url: r.url,
                  priority: r.priority ?? 'NORMAL',
                },
                call,
                logger
              )
            )
          )
        );

        const raw = await call('/keyword/new/list', { method: 'POST', data: built });
        const items = Array.isArray(raw) ? raw : raw?.data || raw?.items || raw?.keywords || [];
        const ids = items.map((it) => it?.id).filter(Boolean);
        ids.forEach((id) => rawCacheSet(`kw:${id}`, items.find((x) => x.id === id)));

        const data = omitUndefined({
          count: items.length,
          ids,
          next: ids.length
            ? {
                poll_tool: 'georanker.keywords.batch_get',
                poll_args: { ids, outputMode: oMode },
              }
            : undefined,
        });

        return makeOk({ action, request, data, meta: { truncated: false, truncatedPaths: [] } });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsBatchGet({ ids, outputMode: mode, maxPreviewItems }) {
      const action = 'georanker.keywords.batch_get';
      const request = { count: ids?.length ?? 0 };
      const oMode = outputMode(mode);
      const previewN = maxPreviewItems ?? maxPreviewDefault;

      try {
        const raw = await call('/keyword/list', { method: 'POST', data: { ids } });
        const list = Array.isArray(raw) ? raw : raw?.data || raw?.items || raw?.keywords || [];
        for (const it of list) {
          const id = it?.id;
          if (id) rawCacheSet(`kw:${id}`, it);
        }

        if (oMode === 'raw') {
          const { pruned, meta } = shapeRaw(list, { maxArrayItems: 100 });
          return makeOk({ action, request, data: pruned, meta });
        }

        const items = list.map((it) => compactKeyword(it, { maxItems: previewN }));
        const readyCount = items.filter((x) => x.ready).length;

        return makeOk({
          action,
          request,
          data: {
            total: items.length,
            ready: readyCount,
            pending: items.length - readyCount,
            items,
          },
          meta: { truncated: false, truncatedPaths: [] },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async keywordsSuggest({ seed, region, source, limit }) {
      const action = 'georanker.keywords.suggest';
      const request = { seed, region, source, limit };
      try {
        // This uses the existing /keyword/new endpoint with suggestions=true in a synchronous request
        const raw = await call('/keyword/new', {
          method: 'POST',
          data: {
            keywords: [seed],
            region: region ? await resolveRegion(region, call, logger) : undefined,
            source: source ?? 'google',
            suggestions: true,
            priority: 'LOW',
            asynchronous: false,
          },
        });
        const summary = compactKeyword(raw, { maxItems: limit ?? 10 });
        return makeOk({
          action,
          request,
          data: summary,
          meta: { truncated: false, truncatedPaths: [] },
          links: { raw_resource: raw?.id ? `georanker://keywords/${raw.id}` : undefined },
        });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },

    async serpCompareLocations(args) {
      const action = 'georanker.serp.compare_locations';
      const request = { keyword: args.keyword, regions: args.regions, device: args.device, searchEngine: args.searchEngine };
      const previewN = Math.min(args.maxResults ?? maxPreviewDefault, 10);
      const timeoutMs = args.timeoutMs ?? 180_000;

      try {
        const limit = pLimit(5);

        // Create jobs (async)
        const jobs = await Promise.all(
          args.regions.map((region) =>
            limit(async () => {
              const payload = await buildSerpRequest(
                {
                  keyword: args.keyword,
                  region,
                  language: args.language,
                  searchEngine: args.searchEngine ?? 'google',
                  device: args.device ?? 'desktop',
                  maxResults: args.maxResults ?? 10,
                  priority: args.priority ?? 'NORMAL',
                },
                call,
                logger
              );

              const job = await call('/serp/new', { method: 'POST', data: payload }); // defaults async
              const id = job?.id;
              if (id) rawCacheSet(`serp:${id}`, job);
              return { region, id };
            })
          )
        );

        // Poll until ready
        const results = await Promise.all(
          jobs.map((j) =>
            limit(async () => {
              if (!j.id) return { region: j.region, id: null, ready: false, error: 'Missing job id' };
              try {
                const full = await pollReady(call, `/serp/${j.id}`, timeoutMs);
                rawCacheSet(`serp:${j.id}`, full);
                return { region: j.region, id: j.id, ready: true, raw: full };
              } catch (e) {
                return { region: j.region, id: j.id, ready: false, error: e?.message || String(e) };
              }
            })
          )
        );

        // Build comparison (top urls)
        const perRegion = results.map((r) => {
          if (!r.ready) return { region: r.region, id: r.id, ready: false, error: r.error };
          const summary = compactSerp(r.raw, { maxItems: previewN });
          const urls = summary?.results?.preview?.map((x) => x.url).filter(Boolean) || [];
          return omitUndefined({ region: r.region, id: r.id, ready: true, top_urls: urls, preview: summary?.results?.preview });
        });

        const urlSets = perRegion
          .filter((r) => r.ready)
          .map((r) => new Set((r.top_urls || []).map((u) => u)));

        // intersection of top urls across regions
        let shared = null;
        for (const s of urlSets) {
          shared = shared ? new Set([...shared].filter((u) => s.has(u))) : new Set([...s]);
        }

        const data = omitUndefined({
          keyword: args.keyword,
          searchEngine: args.searchEngine ?? 'google',
          device: args.device ?? 'desktop',
          regions: perRegion,
          shared_top_urls: shared ? [...shared].slice(0, 20) : [],
          note:
            'Comparison is based on the top results preview (not the full SERP). Use raw_resource links per region for full analysis.',
        });

        return makeOk({ action, request, data, meta: { truncated: false, truncatedPaths: [] } });
      } catch (error) {
        return makeErr({ action, request, error });
      }
    },
  };
}

/** -----------------------------
 * MCP server factory
 * ------------------------------*/
export function createServer(config = {}) {
  // config may come from Smithery, CLI, or env vars
  const georankerApiKey = config.georankerApiKey ?? process.env.GEORANKER_API_KEY;
  const georankerApiBaseUrl = config.georankerApiBaseUrl ?? process.env.GEORANKER_API_BASE_URL ?? 'https://api.highvolume.georanker.com';
  const verbose = Boolean(config.verbose ?? (process.env.GR_VERBOSE === 'true'));
  const enableLegacyToolNames = Boolean(config.enableLegacyToolNames ?? (process.env.GR_ENABLE_LEGACY_TOOL_NAMES === 'true'));

  const defaults = {
    outputMode: config.outputMode ?? process.env.GR_OUTPUT_MODE ?? 'compact',
    maxPreviewItems: Number(config.maxPreviewItems ?? process.env.GR_MAX_PREVIEW_ITEMS ?? 10),
    maxStringChars: Number(config.maxStringChars ?? process.env.GR_MAX_STRING_CHARS ?? 800),
  };

  const logger = createLogger(verbose);

  const { call } = createGeoRankerCaller({ apiKey: georankerApiKey, baseUrl: georankerApiBaseUrl, verbose });

  const server = new McpServer(
    { name: 'georanker-mcp', version: PACKAGE_VERSION },
    { capabilities: { logging: {} } }
  );

  // Resource: regions list (full)
  server.registerResource(
    'regions',
    'georanker://regions',
    {
      title: 'GeoRanker Regions List',
      description: 'Full list of GeoRanker regions (countries / locations) with ids and codes.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const regions = await loadRegions(call, logger);
      const payload = { total: regions.length, regions };
      const { text } = safeStringify(payload, 5 * 1024 * 1024); // allow bigger resources
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    }
  );

  // Resource templates: raw JSON fetchers
  server.registerResource(
    'serp-raw',
    new ResourceTemplate('georanker://serp/{id}', { list: undefined }),
    {
      title: 'Raw SERP JSON',
      description: 'Full raw SERP JSON for a given SERP id. Potentially large.',
      mimeType: 'application/json',
    },
    async (uri, { id }) => {
      const cacheKey = `serp:${id}`;
      const cached = rawCacheGet(cacheKey);
      const raw = cached ?? (await call(`/serp/${id}`, { method: 'GET' }));
      rawCacheSet(cacheKey, raw);
      const { text } = safeStringify(raw, 10 * 1024 * 1024);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    }
  );

  server.registerResource(
    'keywords-raw',
    new ResourceTemplate('georanker://keywords/{id}', { list: undefined }),
    {
      title: 'Raw Keyword Report JSON',
      description: 'Full raw keyword report JSON for a given keyword report id. Potentially large.',
      mimeType: 'application/json',
    },
    async (uri, { id }) => {
      const cacheKey = `kw:${id}`;
      const cached = rawCacheGet(cacheKey);
      const raw = cached ?? (await call(`/keyword/${id}`, { method: 'GET' }));
      rawCacheSet(cacheKey, raw);
      const { text } = safeStringify(raw, 10 * 1024 * 1024);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    }
  );

  server.registerResource(
    'whois-raw',
    new ResourceTemplate('georanker://whois/{domain}', { list: undefined }),
    {
      title: 'Raw WHOIS JSON',
      description: 'Full raw WHOIS JSON for a domain. Potentially large.',
      mimeType: 'application/json',
    },
    async (uri, { domain }) => {
      const d = decodeURIComponent(domain);
      const cacheKey = `whois:${d}`;
      const cached = rawCacheGet(cacheKey);
      const raw = cached ?? (await call('/whois', { method: 'GET', params: { domain: d } }));
      rawCacheSet(cacheKey, raw);
      const { text } = safeStringify(raw, 10 * 1024 * 1024);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    }
  );

  server.registerResource(
    'technologies-raw',
    new ResourceTemplate('georanker://technologies/{domain}', { list: undefined }),
    {
      title: 'Raw Technologies JSON',
      description: 'Full raw technologies detection JSON for a domain. Potentially large.',
      mimeType: 'application/json',
    },
    async (uri, { domain }) => {
      const d = decodeURIComponent(domain);
      const cacheKey = `tech:${d}`;
      const cached = rawCacheGet(cacheKey);
      const raw = cached ?? (await call('/technologies', { method: 'GET', params: { domain: d } }));
      rawCacheSet(cacheKey, raw);
      const { text } = safeStringify(raw, 10 * 1024 * 1024);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    }
  );

  const handlers = createHandlers({ call, logger, defaults });

  /** -----------------------------
   * Register tools (new names)
   * ------------------------------*/
  server.registerTool(
    'georanker.health.check',
    {
      title: 'GeoRanker API Health Check',
      description:
        'Check if the GeoRanker API is reachable. Use before running a batch to avoid wasting retries.',
      inputSchema: {},
    },
    async () => toolResultFromObject(await handlers.healthCheck())
  );

  server.registerTool(
    'georanker.account.get',
    {
      title: 'GeoRanker Account Info',
      description:
        'Fetch the current GeoRanker account information for the configured API key (plan/credits/etc).',
      inputSchema: {},
    },
    async () => toolResultFromObject(await handlers.accountGet())
  );

  server.registerTool(
    'georanker.regions.list',
    {
      title: 'List GeoRanker Regions',
      description:
        'Get a preview of available regions (countries/locations). Use the resource georanker://regions for the full list.',
      inputSchema: {},
    },
    async () => toolResultFromObject(await handlers.regionsList())
  );

  server.registerTool(
    'georanker.domain.whois',
    {
      title: 'WHOIS Lookup',
      description:
        'Get WHOIS data for a domain. Use when you need registrar, dates, nameservers, or contacts. Returns compact JSON + raw_resource.',
      inputSchema: DomainSchema,
    },
    async (args) => toolResultFromObject(await handlers.domainWhois(args))
  );

  server.registerTool(
    'georanker.domain.technologies',
    {
      title: 'Technology Detection',
      description:
        'Detect technologies used by a website/domain (CMS, analytics, ecommerce, etc). Returns a compact list + raw_resource.',
      inputSchema: DomainSchema,
    },
    async (args) => toolResultFromObject(await handlers.domainTechnologies(args))
  );

  server.registerTool(
    'georanker.serp.create',
    {
      title: 'Create SERP Job',
      description:
        'Fetch a geo-located SERP for a keyword. Prefer asynchronous mode for speed; poll with georanker.serp.get until ready. Output is compact + raw_resource.',
      inputSchema: SerpCreateSchema,
    },
    async (args) => toolResultFromObject(await handlers.serpCreate(args))
  );

  server.registerTool(
    'georanker.serp.get',
    {
      title: 'Get SERP by ID',
      description:
        'Retrieve SERP results for a job id from georanker.serp.create. Returns compact preview by default + raw_resource.',
      inputSchema: SerpGetSchema,
    },
    async (args) => toolResultFromObject(await handlers.serpGet(args))
  );

  server.registerTool(
    'georanker.serp.delete',
    {
      title: 'Delete SERP Job',
      description: 'Delete a SERP job by id (cleanup).',
      inputSchema: { id: z.string().min(1).describe('SERP job id') },
    },
    async (args) => toolResultFromObject(await handlers.serpDelete(args))
  );

  server.registerTool(
    'georanker.serp.batch_create',
    {
      title: 'Create SERP Jobs in Bulk',
      description:
        'Create up to 1000 SERP jobs in one request. Use for bulk SERP crawling. Returns ids you can poll with georanker.serp.batch_get.',
      inputSchema: {
        requests: z
          .array(
            z.object({
              keyword: z.string().min(1),
              region: RegionSchema,
              language: z.string().optional(),
              searchEngine: SearchEngineSchema.optional(),
              device: DeviceEnum.optional(),
              maxResults: z.number().int().min(1).max(100).optional(),
              priority: PriorityEnum.optional(),
              customUrlParameter: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
              customCookieParameter: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
            })
          )
          .min(1)
          .max(1000)
          .describe('List of SERP requests'),
        outputMode: OutputModeEnum.optional(),
      },
    },
    async (args) => toolResultFromObject(await handlers.serpBatchCreate(args))
  );

  server.registerTool(
    'georanker.serp.batch_get',
    {
      title: 'Get Multiple SERPs',
      description:
        'Fetch multiple SERP results by id (up to 1000). Returns compact summaries + ready counts by default.',
      inputSchema: SerpListGetSchema,
    },
    async (args) => toolResultFromObject(await handlers.serpBatchGet(args))
  );

  server.registerTool(
    'georanker.serp.compare_locations',
    {
      title: 'Compare SERP Across Regions',
      description:
        'Compare a keyword SERP across 2-10 regions. Creates jobs, polls until ready, and returns a compact per-region preview + shared URLs.',
      inputSchema: CompareLocationsSchema,
    },
    async (args) => toolResultFromObject(await handlers.serpCompareLocations(args))
  );

  server.registerTool(
    'georanker.keywords.create',
    {
      title: 'Create Keyword Report',
      description:
        'Analyze keyword(s) for volume/CPC/competition. Prefer async for speed; poll with georanker.keywords.get. Returns compact preview + raw_resource.',
      inputSchema: KeywordCreateSchema,
    },
    async (args) => toolResultFromObject(await handlers.keywordsCreate(args))
  );

  server.registerTool(
    'georanker.keywords.get',
    {
      title: 'Get Keyword Report by ID',
      description:
        'Retrieve keyword analysis results by report id. Returns compact preview + raw_resource.',
      inputSchema: KeywordGetSchema,
    },
    async (args) => toolResultFromObject(await handlers.keywordsGet(args))
  );

  server.registerTool(
    'georanker.keywords.delete',
    {
      title: 'Delete Keyword Report',
      description: 'Delete a keyword report by id (cleanup).',
      inputSchema: { id: z.string().min(1).describe('Keyword report id') },
    },
    async (args) => toolResultFromObject(await handlers.keywordsDelete(args))
  );

  server.registerTool(
    'georanker.keywords.batch_create',
    {
      title: 'Create Keyword Reports in Bulk',
      description:
        'Create up to 1000 keyword reports in one request. Returns ids to poll with georanker.keywords.batch_get.',
      inputSchema: {
        requests: z
          .array(
            z.object({
              keywords: z.array(z.string().min(1)).min(1).max(1000),
              region: RegionSchema,
              source: z.enum(['google', 'baidu']).optional(),
              suggestions: z.boolean().optional(),
              url: z.string().optional(),
              priority: PriorityEnum.optional(),
            })
          )
          .min(1)
          .max(1000),
        outputMode: OutputModeEnum.optional(),
      },
    },
    async (args) => toolResultFromObject(await handlers.keywordsBatchCreate(args))
  );

  server.registerTool(
    'georanker.keywords.batch_get',
    {
      title: 'Get Multiple Keyword Reports',
      description:
        'Fetch multiple keyword report results by id (up to 1000). Returns compact summaries + ready counts by default.',
      inputSchema: KeywordListGetSchema,
    },
    async (args) => toolResultFromObject(await handlers.keywordsBatchGet(args))
  );

  server.registerTool(
    'georanker.keywords.suggest',
    {
      title: 'Keyword Suggestions',
      description:
        'Get keyword suggestions from a seed keyword (compact). Internally uses GeoRanker suggestions mode. Returns preview + raw_resource.',
      inputSchema: KeywordSuggestSchema,
    },
    async (args) => toolResultFromObject(await handlers.keywordsSuggest(args))
  );

  /** -----------------------------
   * Legacy tool names (optional)
   * ------------------------------*/
  if (enableLegacyToolNames) {
    const legacy = (name, newName) => ({
      title: `DEPRECATED: ${name}`,
      description: `Deprecated tool name. Use "${newName}" instead.`,
    });

    server.registerTool('heartbeat', { ...legacy('heartbeat', 'georanker.health.check'), inputSchema: {} }, async () =>
      toolResultFromObject(await handlers.healthCheck())
    );
    server.registerTool('get_user', { ...legacy('get_user', 'georanker.account.get'), inputSchema: {} }, async () =>
      toolResultFromObject(await handlers.accountGet())
    );
    server.registerTool('list_regions', { ...legacy('list_regions', 'georanker.regions.list'), inputSchema: {} }, async () =>
      toolResultFromObject(await handlers.regionsList())
    );

    server.registerTool('get_whois', { ...legacy('get_whois', 'georanker.domain.whois'), inputSchema: DomainSchema }, async (args) =>
      toolResultFromObject(await handlers.domainWhois(args))
    );
    server.registerTool(
      'get_technologies',
      { ...legacy('get_technologies', 'georanker.domain.technologies'), inputSchema: DomainSchema },
      async (args) => toolResultFromObject(await handlers.domainTechnologies(args))
    );

    server.registerTool('create_serp', { ...legacy('create_serp', 'georanker.serp.create'), inputSchema: SerpCreateSchema }, async (args) =>
      toolResultFromObject(await handlers.serpCreate(args))
    );
    server.registerTool('get_serp', { ...legacy('get_serp', 'georanker.serp.get'), inputSchema: SerpGetSchema }, async (args) =>
      toolResultFromObject(await handlers.serpGet(args))
    );
    server.registerTool('delete_serp', { ...legacy('delete_serp', 'georanker.serp.delete'), inputSchema: { id: z.string() } }, async (args) =>
      toolResultFromObject(await handlers.serpDelete(args))
    );

    server.registerTool(
      'create_keyword',
      { ...legacy('create_keyword', 'georanker.keywords.create'), inputSchema: KeywordCreateSchema },
      async (args) => toolResultFromObject(await handlers.keywordsCreate(args))
    );
    server.registerTool(
      'get_keyword',
      { ...legacy('get_keyword', 'georanker.keywords.get'), inputSchema: KeywordGetSchema },
      async (args) => toolResultFromObject(await handlers.keywordsGet(args))
    );
    server.registerTool(
      'delete_keyword',
      { ...legacy('delete_keyword', 'georanker.keywords.delete'), inputSchema: { id: z.string() } },
      async (args) => toolResultFromObject(await handlers.keywordsDelete(args))
    );
    server.registerTool(
      'search_keywords',
      { ...legacy('search_keywords', 'georanker.keywords.suggest'), inputSchema: KeywordSuggestSchema },
      async (args) => toolResultFromObject(await handlers.keywordsSuggest(args))
    );

    server.registerTool(
      'compare_locations',
      { ...legacy('compare_locations', 'georanker.serp.compare_locations'), inputSchema: CompareLocationsSchema },
      async (args) => toolResultFromObject(await handlers.serpCompareLocations(args))
    );

    server.registerTool(
      'create_serp_list',
      {
        ...legacy('create_serp_list', 'georanker.serp.batch_create'),
        inputSchema: {
          requests: z.array(z.any()).min(1).max(1000),
          outputMode: OutputModeEnum.optional(),
        },
      },
      async (args) => toolResultFromObject(await handlers.serpBatchCreate(args))
    );

    server.registerTool(
      'get_serp_list',
      { ...legacy('get_serp_list', 'georanker.serp.batch_get'), inputSchema: SerpListGetSchema },
      async (args) => toolResultFromObject(await handlers.serpBatchGet(args))
    );

    server.registerTool(
      'create_keyword_list',
      {
        ...legacy('create_keyword_list', 'georanker.keywords.batch_create'),
        inputSchema: {
          requests: z.array(z.any()).min(1).max(1000),
          outputMode: OutputModeEnum.optional(),
        },
      },
      async (args) => toolResultFromObject(await handlers.keywordsBatchCreate(args))
    );

    server.registerTool(
      'get_keyword_list',
      { ...legacy('get_keyword_list', 'georanker.keywords.batch_get'), inputSchema: KeywordListGetSchema },
      async (args) => toolResultFromObject(await handlers.keywordsBatchGet(args))
    );
  }

  return { server, handlers, defaults, logger, georankerApiBaseUrl, georankerApiKey };
}

export default createServer;

/** -----------------------------
 * HTTP server (Streamable HTTP + optional SSE + OpenAPI)
 * ------------------------------*/
function buildServerCard({ publicUrl, enableDeprecatedSse, requireAuth, toolsPreview }) {
  // Server card is used by registries/scanners (e.g., Smithery) for discovery.
  // We include multiple commonly-used fields to maximize compatibility across scanners.
  const base = publicUrl ? publicUrl.replace(/\/$/, '') : undefined;

  const streamable = base ? `${base}/mcp` : undefined;
  const sse = enableDeprecatedSse && base ? `${base}/sse` : undefined;
  const messages = enableDeprecatedSse && base ? `${base}/messages` : undefined;

  const description =
    'Agent-optimized MCP server for the GeoRanker High-Volume API (SERPs, keyword reports, WHOIS, technologies).';

  return omitUndefined({
    schema_version: '1.0',
    name: 'georanker-mcp',
    version: PACKAGE_VERSION,
    description,

    serverInfo: { name: 'georanker-mcp', version: PACKAGE_VERSION, description },

    capabilities: { tools: true, resources: true, prompts: false },

    authentication: requireAuth ? { required: true, type: 'bearer' } : { required: false },

    // Common endpoint naming patterns
    endpoints: omitUndefined({
      streamable_http: streamable ? { url: streamable } : undefined,
      http_sse: sse ? { url: sse, messages_url: messages } : undefined,
    }),

    // Back-compat (some scanners look for "transports")
    transports: omitUndefined({
      streamableHttp: streamable,
      httpSse: sse,
    }),

    tools: toolsPreview,

    resources: [
      { uri: 'georanker://regions', name: 'regions', description: 'Full GeoRanker regions list' },
      { uri: 'georanker://serp/{id}', name: 'serp-raw', description: 'Raw SERP JSON by id' },
      { uri: 'georanker://keywords/{id}', name: 'keywords-raw', description: 'Raw keyword report JSON by id' },
      { uri: 'georanker://whois/{domain}', name: 'whois-raw', description: 'Raw WHOIS JSON by domain' },
      { uri: 'georanker://technologies/{domain}', name: 'technologies-raw', description: 'Raw technologies JSON by domain' },
    ],

    prompts: [],
  });
}


function buildOpenApiSpec({ publicUrl, requireAuth }) {
  const base = publicUrl?.replace(/\/$/, '') || 'http://localhost:3333';

  return {
    openapi: '3.1.0',
    info: {
      title: 'GeoRanker MCP HTTP API',
      version: PACKAGE_VERSION,
      description:
        'HTTP wrapper for GeoRanker MCP tools. Use /mcp for MCP clients (Streamable HTTP). Use /api/v1/* endpoints for non-MCP clients (OpenAI Actions, generic HTTP).',
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: requireAuth
        ? {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          }
        : {},
    },
    security: requireAuth ? [{ bearerAuth: [] }] : [],
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Health check',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/openapi.json': {
        get: { operationId: 'openapi', summary: 'OpenAPI spec', responses: { '200': { description: 'OK' } } },
      },
      '/.well-known/mcp/server-card.json': {
        get: { operationId: 'serverCard', summary: 'MCP server card', responses: { '200': { description: 'OK' } } },
      },

      // Minimal endpoint docs; full schemas are on MCP tools.
      '/api/v1/serp': {
        post: {
          operationId: 'serpCreate',
          summary: 'Create SERP job (GeoRanker)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { keyword: { type: 'string' }, region: { type: 'string' } }, required: ['keyword', 'region'] } } },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/serp/{id}': {
        get: {
          operationId: 'serpGet',
          summary: 'Get SERP job by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
        delete: {
          operationId: 'serpDelete',
          summary: 'Delete SERP job by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/keywords': {
        post: {
          operationId: 'keywordsCreate',
          summary: 'Create keyword report (GeoRanker)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' } }, region: { type: 'string' } }, required: ['keywords', 'region'] } } },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/keywords/{id}': {
        get: {
          operationId: 'keywordsGet',
          summary: 'Get keyword report by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
        delete: {
          operationId: 'keywordsDelete',
          summary: 'Delete keyword report by id',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/domain/whois': {
        get: {
          operationId: 'whois',
          summary: 'WHOIS lookup',
          parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/domain/technologies': {
        get: {
          operationId: 'technologies',
          summary: 'Detect technologies for a domain',
          parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/regions': {
        get: { operationId: 'regions', summary: 'List regions preview', responses: { '200': { description: 'OK' } } },
      },
    },
  };
}

async function startHttpServer({ config, logger }) {
  const host = config.http?.host ?? '127.0.0.1';
  const port = config.http?.port ?? 3333;
  const mcpPath = config.http?.path ?? '/mcp';
  const enableDeprecatedSse = config.http?.enableDeprecatedSse ?? true;
  const authToken = config.http?.authToken ?? process.env.MCP_AUTH_TOKEN;
  const publicUrl = config.http?.publicUrl ?? process.env.MCP_PUBLIC_URL;
  const requireAuth = Boolean(authToken);

  // Express app with DNS-rebinding protection defaults when binding to localhost
  const hostHeaderValidation =
    host === '127.0.0.1' || host === 'localhost'
      ? ['127.0.0.1', 'localhost']
      : undefined;

  const app = createMcpExpressApp({ hostHeaderValidation });

  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  const checkAuth = (req, res) => {
    if (!requireAuth) return true;
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice('Bearer '.length) : null;
    if (token && token === authToken) return true;
    res.status(401).json({ ok: false, error: { message: 'Unauthorized' } });
    return false;
  };

  // Health endpoint
  app.get('/health', async (req, res) => {
    if (!checkAuth(req, res)) return;
    res.json({ ok: true, name: 'georanker-mcp', version: PACKAGE_VERSION });
  });

  // OpenAPI export
  app.get('/openapi.json', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const derived = `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApiSpec({ publicUrl: publicUrl || derived, requireAuth }));
  });

  // Server Card export
  app.get('/.well-known/mcp/server-card.json', async (req, res) => {
    // Do NOT require auth for discovery (Smithery scanning may need it). If you want, put it behind auth.
    const derived = `${req.protocol}://${req.get('host')}`;
    const toolsPreview = [
      { name: 'georanker.serp.create', description: 'Create geo-located SERP job', inputSchema: { type: 'object' } },
      { name: 'georanker.serp.get', description: 'Get SERP job result by id', inputSchema: { type: 'object' } },
      { name: 'georanker.keywords.create', description: 'Create keyword report', inputSchema: { type: 'object' } },
      { name: 'georanker.keywords.get', description: 'Get keyword report by id', inputSchema: { type: 'object' } },
    ];
    res.json(
      buildServerCard({
        publicUrl: publicUrl || derived,
        enableDeprecatedSse,
        requireAuth,
        toolsPreview,
      })
    );
  });

  // Simple HTTP API wrapper (useful for OpenAI Actions / non-MCP clients)
  app.post('/api/v1/serp', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.serpCreate({ ...req.body, synchronous: true });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.get('/api/v1/serp/:id', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.serpGet({ id: req.params.id, outputMode: req.query.outputMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.delete('/api/v1/serp/:id', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.serpDelete({ id: req.params.id });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.post('/api/v1/keywords', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.keywordsCreate({ ...req.body, synchronous: true });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.get('/api/v1/keywords/:id', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.keywordsGet({ id: req.params.id, outputMode: req.query.outputMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.delete('/api/v1/keywords/:id', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.keywordsDelete({ id: req.params.id });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.get('/api/v1/domain/whois', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const domain = req.query.domain;
      if (!domain) return res.status(400).json({ ok: false, error: { message: 'Missing domain query parameter' } });

      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.domainWhois({ domain, outputMode: req.query.outputMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.get('/api/v1/domain/technologies', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const domain = req.query.domain;
      if (!domain) return res.status(400).json({ ok: false, error: { message: 'Missing domain query parameter' } });

      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.domainTechnologies({ domain, outputMode: req.query.outputMode });
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  app.get('/api/v1/regions', async (req, res) => {
    if (!checkAuth(req, res)) return;
    try {
      const cfg = { ...config };
      const { call } = createGeoRankerCaller({
        apiKey: cfg.georankerApiKey,
        baseUrl: cfg.georankerApiBaseUrl,
        verbose: cfg.verbose,
      });
      const handlers = createHandlers({ call, logger, defaults: cfg });
      const out = await handlers.regionsList();
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: { message: e?.message || String(e) } });
    }
  });

  // MCP Streamable HTTP endpoint (stateful sessions)
  const sessions = new Map(); // sessionId -> {server, transport, lastSeen}
  const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 30 * 60_000);
  const cleanupInterval = setInterval(async () => {
    const now = Date.now();
    for (const [sid, sess] of sessions.entries()) {
      if (now - (sess.lastSeen || now) > SESSION_TTL_MS) {
        try {
          await sess.transport.close();
        } catch {}
        sessions.delete(sid);
      }
    }
  }, 60_000).unref?.();

  async function getOrCreateSession(req) {
    const headerSid = req.headers['mcp-session-id'];
    if (headerSid && sessions.has(headerSid)) {
      const s = sessions.get(headerSid);
      s.lastSeen = Date.now();
      return s;
    }

    const s = createServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const sess = { server: s.server, transport, lastSeen: Date.now() };

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    await s.server.connect(transport);

    // Not stored until sessionId is known (after initialize)
    return sess;
  }

  app.all(mcpPath, async (req, res) => {
    if (!checkAuth(req, res)) return;

    try {
      const sess = await getOrCreateSession(req);
      await sess.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);

      const sid = sess.transport.sessionId;
      if (sid && !sessions.has(sid)) sessions.set(sid, sess);
      sess.lastSeen = Date.now();
    } catch (e) {
      logger.warn('MCP HTTP handler error', e?.message || e);
      if (!res.headersSent) res.status(500).send('MCP server error');
    }
  });

  // Deprecated HTTP+SSE transport (optional)
  const sseTransports = new Map(); // sessionId -> SSEServerTransport
  if (enableDeprecatedSse) {
    app.get('/sse', async (req, res) => {
      if (!checkAuth(req, res)) return;
      try {
        const transport = new SSEServerTransport('/messages', res);
        sseTransports.set(transport.sessionId, transport);
        transport.onclose = () => sseTransports.delete(transport.sessionId);

        const s = createServer(config);
        await s.server.connect(transport);
      } catch (e) {
        logger.warn('SSE init error', e?.message || e);
        if (!res.headersSent) res.status(500).send('Error establishing SSE');
      }
    });

    app.post('/messages', async (req, res) => {
      if (!checkAuth(req, res)) return;
      const sessionId = req.query.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).send('Missing sessionId parameter');
        return;
      }
      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.status(404).send('Session not found');
        return;
      }
      try {
        await transport.handlePostMessage(req, res, req.body);
      } catch (e) {
        logger.warn('SSE message error', e?.message || e);
        if (!res.headersSent) res.status(500).send('Error handling message');
      }
    });
  }

  const server = app.listen(port, host, () => {
    logger.warn(`HTTP server listening on http://${host}:${port}`);
    logger.warn(`MCP Streamable HTTP endpoint: http://${host}:${port}${mcpPath}`);
    if (enableDeprecatedSse) logger.warn(`Deprecated SSE endpoint: http://${host}:${port}/sse`);
    logger.warn(`OpenAPI spec: http://${host}:${port}/openapi.json`);
    logger.warn(`Server card: http://${host}:${port}/.well-known/mcp/server-card.json`);
  });

  const shutdown = async () => {
    clearInterval(cleanupInterval);
    try {
      server.close();
    } catch {}

    // Close sessions
    for (const sess of sessions.values()) {
      try {
        await sess.transport.close();
      } catch {}
    }
    for (const t of sseTransports.values()) {
      try {
        await t.close();
      } catch {}
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** -----------------------------
 * Entrypoint (CLI)
 * ------------------------------*/
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const merged = {
    georankerApiKey: args.georankerApiKey ?? process.env.GEORANKER_API_KEY,
    georankerApiBaseUrl: args.georankerApiBaseUrl ?? process.env.GEORANKER_API_BASE_URL ?? 'https://api.highvolume.georanker.com',
    verbose: Boolean(args.verbose ?? (process.env.GR_VERBOSE === 'true')),
    enableLegacyToolNames: Boolean(args.enableLegacyToolNames ?? (process.env.GR_ENABLE_LEGACY_TOOL_NAMES === 'true')),
    outputMode: process.env.GR_OUTPUT_MODE ?? 'compact',
    maxPreviewItems: Number(process.env.GR_MAX_PREVIEW_ITEMS ?? 10),
    maxStringChars: Number(process.env.GR_MAX_STRING_CHARS ?? 800),
    http: {
      enabled: false,
      host: args.host ?? process.env.MCP_HOST ?? '127.0.0.1',
      port: Number(args.port ?? process.env.MCP_PORT ?? 3333),
      path: args.path ?? process.env.MCP_PATH ?? '/mcp',
      enableDeprecatedSse: args.enableDeprecatedSse ?? (process.env.MCP_ENABLE_DEPRECATED_SSE !== 'false'),
      authToken: args.authToken ?? process.env.MCP_AUTH_TOKEN,
      publicUrl: args.publicUrl ?? process.env.MCP_PUBLIC_URL,
    },
  };

  const logger = createLogger(merged.verbose);

  const transport = (args.transport ?? process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();

  if (transport === 'http') {
    merged.http.enabled = true;
    await startHttpServer({ config: merged, logger });
    return;
  }

  // stdio
  const { server } = createServer(merged);
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  logger.warn('GeoRanker MCP server running on stdio');
}

// Only run main when executed directly
const isMain = (() => {
  try {
    const thisPath = path.resolve(fileURLToPath(import.meta.url));
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : null;
    return argv1 === thisPath;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[georanker-mcp] Fatal error:', err);
    process.exit(1);
  });
}
