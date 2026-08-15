# Localazy MCP Server

Connects Claude to the Fractory Localazy project. Claude can search keys, audit translations, and upload updates through conversation.

The server works with one project. It resolves that project from the API token, so no tool takes a project ID.

## Setup

### 1. Build the server

```bash
npm install
npm run build
```

### 2. Create your local configuration

Copy the example file:

```bash
cp .mcp.example.json .mcp.json
```

Open `.mcp.json` and fill in two values:

- `cwd` — the absolute path to your clone of this repository
- `LOCALAZY_API_TOKEN` — a token from the [Localazy Console](https://localazy.com/developer/tokens)

These optional variables tune behavior:

| Variable | Default | Effect |
|---|---|---|
| `LOCALAZY_RATE_LIMIT` | 90 | Maximum API requests per minute. The Localazy limit is 100. |
| `LOCALAZY_RATE_LIMIT_PER_SECOND` | 30 | Maximum API requests per second. |
| `LOCALAZY_FILE_CONCURRENCY` | 8 | How many files a project-wide scan reads in parallel. |
| `LOCALAZY_CHARACTER_LIMIT` | 50000 | Maximum characters in one tool response. |

### Rate limits

Both limits are sliding windows, and the server holds requests until every window
has room.

Localazy documents 100 requests per minute and 10 requests per second. The
per-minute ceiling is enforced near the documented value, because exceeding it is
the one thing measured to return 429. The per-second default sits above the
documented 10 on purpose: a parallel scan peaks near 22 requests per second, the
API serves that without complaint, and holding to 10 more than doubles the time
of a cold scan.

If the API does start to refuse requests, the server halves its per-second rate
for the rest of the session and writes the reason to stderr. Set
`LOCALAZY_RATE_LIMIT_PER_SECOND` to 9 to hold to the documented limit from the
start.

### 3. Connect to Claude

**Claude Code** — add the server to your project or global configuration:

```bash
claude mcp add "Localazy" node dist/index.js --cwd /path/to/localazy-mcp -e LOCALAZY_API_TOKEN=<token>
```

**Claude Desktop** — open Settings > MCP Servers and add the contents of your `.mcp.json`.

### 4. Use it

Talk to Claude about translations:

- "Find invoice-related keys in ET"
- "Show checkout strings in Estonian"
- "Audit ET translations"
- "Audit ET style"
- "Audit FR syntax"
- "Which ET strings use straight apostrophes?"
- "Which languages are configured?"
- "Upload these translations: ..."

## Available tools

### Read-only

| Tool | What it does |
|---|---|
| `localazy_find_translations` | Searches key names and target values across every file. Accepts optional file IDs. |
| `localazy_audit_translations` | Audits one language for QA issues. The scope is `style`, `syntax`, or `all`. An optional `types` filter narrows the scope to named rules. |
| `localazy_list_languages` | Lists the languages with translation statistics. |
| `localazy_list_files` | Lists the translation files with their IDs. |
| `localazy_list_keys` | Reads one page of keys from one file, with prefix filtering. |

`style` covers punctuation, quotes, dashes, apostrophes, and spacing. `syntax` covers placeholders, tags, and broken tag structure.

`types` accepts an array of rule names. It narrows `scope`, and it cannot widen
it. A request for `dash_style` with scope `syntax` is refused, because
the two exclude each other. Without the refusal, such a request reports zero
issues after a full scan, which looks like a clean language. The response
reports the effective list, so a type that the scope removed stays visible.

A filter that excludes the comparison rules also halves the requests that a scan
makes. The server reads the source language only for the rules that compare
against it. A filter on `apostrophe_style` makes 29 requests instead of 58, and
the response is 949 characters instead of 29942.

### Write

| Tool | What it does |
|---|---|
| `localazy_upload_translations` | Creates or updates keys from nested JSON or flat dot-notation keys. |

## Response format

Two response fields hold values that repeat across results, so each result stays small:

- `files` maps each `file_id` to its readable file path.
- `rules` maps an issue `type` to its fixed message. The message of an audit issue is therefore `message ?? rules[type]`. An issue with a per-occurrence message carries that message inline instead.

When a rule compares the target against the source, its issues also carry `source_value`.

## Development

```bash
npm run dev      # Watch mode
npm run build    # Compile TypeScript
npm test         # Run tests
```

## Notes

- `.mcp.json` is gitignored, because it contains machine-specific paths and a secret
- `.mcp.example.json` is the committed template
- Project data, file lists, and translation values are cached for 15 minutes per session, so only the first project-wide scan is slow. A cold audit takes about 2.5 s, the next language about 1.3 s, and a repeat is instant
- Auditing every language in one session needs about 174 requests, which is over the per-minute ceiling. Expect one pause of up to a minute part way through. The server writes a note to stderr when it waits, so the pause is not mistaken for a hang
- An upload clears the cache
- A request for a language the project does not have is rejected with the list of available languages. Localazy answers such a request with an empty key list and no error, so without the check an unconfigured language looks like a clean audit
- Reading keys does not count against the daily fetch quota, which applies to the file download endpoint this server never calls. Uploads count against the 100 imports per project per day limit
- The server sends an upload once. A 5xx or a dropped connection cannot show whether Localazy accepted the import, so the server does not retry it. It retries only a 429, because that refusal proves nothing was written
