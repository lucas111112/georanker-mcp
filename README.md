# GeoRanker MCP Server v1.5.1

🔍 **Professional SEO & Keyword Research** through the Model Context Protocol

A powerful MCP server that provides seamless access to GeoRanker's comprehensive SEO and keyword research capabilities, enabling AI assistants to perform advanced search engine optimization analysis.

## ✨ Features

### 🎯 **Keyword Research**
- **Search Volume Analysis** - Get monthly search volumes with 12 months of historical data
- **Competition Metrics** - Analyze keyword difficulty and competition levels  
- **Cost-Per-Click Data** - Access Google Ads CPC information
- **Keyword Suggestions** - Generate related keyword ideas from seed terms
- **Bulk Processing** - Analyze multiple keywords simultaneously

### 🌍 **SERP Analysis** 
- **Multi-Region Support** - Compare search results across different countries/regions
- **Device Targeting** - Desktop vs mobile search result analysis
- **Real-time Processing** - Get live search engine results
- **Search Engine Options** - Support for Google and other major search engines

### 🔍 **Domain Intelligence**
- **WHOIS Lookup** - Complete domain registration information
- **Technology Detection** - Identify technologies used by websites
- **Comprehensive Domain Data** - Nameservers, contacts, expiration dates

### ⚡ **Advanced Capabilities**
- **Location Comparison** - Side-by-side SERP analysis across regions
- **Asynchronous Processing** - Queue jobs for large-scale analysis
- **Regional Caching** - Optimized performance with intelligent caching
- **Priority Processing** - REALTIME, INSTANT, and LOW priority options

## 🚀 Quick Start

### Option 1: One-Line Install (Recommended)

```bash
# Install and run with your API key
GEORANKER_API_KEY=your_api_key npx georanker-mcp@latest
```

### Option 2: Local Development

```bash
# Clone and setup
git clone https://github.com/lucas111112/georanker-mcp.git
cd georanker-mcp
npm install

# Configure your API key
cp .env.example .env
# Edit .env and add: GEORANKER_API_KEY=your_key_here

# Run in development mode
npm run dev
```

### Option 3: Production Build

```bash
# Build optimized version
npm run build
npm start
```

## 🔧 Configuration

### MCP Client Setup

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "georanker": {
      "command": "npx",
      "args": ["-y", "georanker-mcp@latest"],
      "env": {
        "GEORANKER_API_KEY": "your_georanker_api_key_here"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|----------|
| `GEORANKER_API_KEY` | Your GeoRanker API key (required) | - |
| `GR_VERBOSE` | Enable verbose logging | `false` |
| `GEORANKER_API_BASE_URL` | Custom API endpoint | `https://api.highvolume.georanker.com` |

### Command Line Options

```bash
# Pass API key via command line
npx georanker-mcp --apikey your_key_here

# Enable verbose mode
npx georanker-mcp --verbose
```

## 📊 Available Tools

### **Keyword Research**
- `create_keyword` - Analyze keywords for search volume, CPC, and competition
- `get_keyword` - Retrieve keyword analysis results by job ID
- `search_keywords` - Generate keyword suggestions from seed terms

### **SERP Analysis**
- `create_serp` - Create search engine results page analysis
- `get_serp` - Get SERP analysis results by job ID
- `compare_locations` - Compare SERP results across different regions

### **Domain Tools**
- `get_whois` - Comprehensive WHOIS domain information
- `get_technologies` - Detect technologies used by websites

### **System Tools**
- `heartbeat` - Check API status and health
- `get_user` - Get current user account information

## 🔍 Example Usage

### Keyword Research
```javascript
// Analyze keyword metrics
const keywords = await georanker.create_keyword({
  keywords: ["SEO tools", "keyword research", "SERP analysis"],
  region: "US",
  synchronous: true
});

// Generate keyword suggestions
const suggestions = await georanker.search_keywords({
  seed: "coffee shop",
  limit: 10
});
```

### Location Comparison
```javascript
// Compare search results across regions
const comparison = await georanker.compare_locations({
  keyword: "best pizza",
  regions: ["US", "GB", "CA"],
  device: "mobile"
});
```

### Domain Analysis
```javascript
// Get domain information
const whois = await georanker.get_whois({
  domain: "example.com"
});

const tech = await georanker.get_technologies({
  domain: "shopify.com"
});
```

## 🌍 Supported Regions

GeoRanker supports 100+ countries and regions including:
- **Americas**: US, CA, BR, MX, AR, CL, CO, PE
- **Europe**: GB, DE, FR, IT, ES, NL, PL, SE, NO
- **Asia-Pacific**: JP, CN, IN, AU, KR, SG, TH, MY
- **And many more...**

Use region codes like `US`, `GB`, `DE` or specific regional formats like `US-NY` for New York.

## 📈 Performance & Limits

- **Concurrent Requests**: Up to 64 simultaneous connections
- **Timeout**: 30 seconds per request
- **Retry Logic**: Automatic retry with exponential backoff
- **Caching**: 24-hour region data caching
- **Rate Limiting**: Respects GeoRanker API limits

## 🛠️ Requirements

- **Node.js**: Version 18.0.0 or higher
- **GeoRanker API Key**: Get yours at [georanker.com](https://georanker.com)
- **MCP Client**: Claude Desktop, or any MCP-compatible application

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines and submit pull requests.

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/lucas111112/georanker-mcp/issues)
- **Documentation**: [GeoRanker API Docs](https://georanker.com/docs)
- **Community**: Join our Discord for discussions

---

**Built with ❤️ for the MCP ecosystem**

*Empowering AI assistants with professional SEO capabilities*