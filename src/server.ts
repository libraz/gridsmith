import { McpServer } from '@modelcontextprotocol/server';
import { registerExport } from './tools/export.js';
import { registerGuide } from './tools/guide.js';
import { registerRender } from './tools/render.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS =
  'Read gridsmith_guide (topic "overview") before writing a spec. ' +
  'Keep the spec in a JSON file and call gridsmith_render with its absolute path to see the drawing and the measured geometry, then edit the file and render again. ' +
  'Call gridsmith_export only once the render reports no violations.';

/** Builds the MCP server with its three tools registered. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'gridsmith', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerGuide(server);
  registerRender(server);
  registerExport(server);
  return server;
}
