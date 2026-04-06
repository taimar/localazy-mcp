# Localazy MCP Server

Gives Claude access to our Localazy translations. Once set up, you can ask Claude to search keys, export translations, and import updates — all through natural conversation.

## Setup

### 1. Build the server

```bash
npm install
npm run build
```

### 2. Create your local config

Copy the example config:

```bash
cp .mcp.example.json .mcp.json
```

Edit `.mcp.json` and fill in:
- `cwd` — absolute path to your clone of this repo
- `LOCALAZY_API_TOKEN` — get one from [Localazy Console](https://localazy.com/developer/tokens)

You can also add optional env variables to tune behavior:
- `LOCALAZY_RATE_LIMIT` — max API requests per minute (default: 90, Localazy limit is 100)
- `LOCALAZY_SEARCH_MAX_RESULTS` — max matching keys returned (default: 1000)
- `LOCALAZY_SEARCH_MAX_PAGES` — max API pages to scan, 1 page = 1000 keys (default: 10, set to 0 for no cap)
- `LOCALAZY_SEARCH_CONCURRENCY` — parallel file searches (default: 3)
- `LOCALAZY_CHARACTER_LIMIT` — max response size in characters (default: 50000, increase for large files)

### 3. Connect to Claude

**Claude Code** — add the server to your project or global settings:

```bash
claude mcp add localazy node dist/index.js --cwd /path/to/localazy-mcp -e LOCALAZY_API_TOKEN=<token>
```

**Claude Desktop** — open Settings > MCP Servers and add the contents of your `.mcp.json`.

### 4. Use it

Just talk to Claude about translations:

- "What translation keys contain 'invoice'?"
- "Show me the Estonian translations"
- "Import these translations: ..."
Claude figures out project and file IDs automatically.

## Available tools

### Read-only

| Tool | Description |
|------|-------------|
| `localazy_list_projects` | List all accessible projects |
| `localazy_list_files` | List translation files in a project |
| `localazy_list_languages` | List languages with translation statistics |
| `localazy_list_keys` | List translation keys with pagination and prefix filtering |
| `localazy_search_keys` | Search keys by name or value across all files |

### Write

| Tool | Description |
|------|-------------|
| `localazy_import_translations` | Import/upload translations |

## Development

```bash
npm run dev      # Watch mode
npm run build    # Compile TypeScript
npm test         # Run tests
```

## Notes

- `.mcp.json` is gitignored — it contains machine-specific paths and secrets
- `.mcp.example.json` is the committed template
