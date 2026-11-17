#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = 'Usage: gridsmith [--version]\nWith no arguments, serves MCP over stdio.\n';

const args = process.argv.slice(2);

if (args.length === 0) {
  await createServer().connect(new StdioServerTransport());
} else if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
