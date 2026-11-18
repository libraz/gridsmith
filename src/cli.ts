#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { runInit, runUninstall } from './install.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `gridsmith ${VERSION}
MCP server that draws logo marks, magic-circle figures and UI icons from a JSON construction spec.

Usage:
  gridsmith             Serve MCP over stdio.
  gridsmith init        Write the gridsmith entry into Claude Code and/or Codex CLI configs.
  gridsmith uninstall   Remove the gridsmith entry from those configs.
  gridsmith --help      Show this help.
  gridsmith --version   Show the version.

Docs: https://github.com/libraz/gridsmith
`;

const [command, ...rest] = process.argv.slice(2);

if (rest.length > 0) {
  process.stderr.write(HELP);
  process.exitCode = 2;
} else if (command === undefined) {
  await createServer().connect(new StdioServerTransport());
} else if (command === '--help' || command === '-h') {
  process.stdout.write(HELP);
} else if (command === '--version' || command === '-v') {
  process.stdout.write(`${VERSION}\n`);
} else if (command === 'init' || command === 'uninstall') {
  try {
    await (command === 'init' ? runInit() : runUninstall());
  } catch (error) {
    process.stderr.write(
      `gridsmith ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
} else {
  process.stderr.write(HELP);
  process.exitCode = 2;
}
