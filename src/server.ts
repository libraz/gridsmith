import { McpServer } from '@modelcontextprotocol/server';
import { registerExport } from './tools/export.js';
import { registerGuide } from './tools/guide.js';
import { registerImport } from './tools/import.js';
import { registerRender } from './tools/render.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS =
  'Read gridsmith_guide (topic "overview") before writing a spec. ' +
  'Keep the spec in a JSON file and call gridsmith_render with its absolute path to see the drawing and the measured geometry, then edit the file and render again. ' +
  'Call gridsmith_export only once the render reports no violations. ' +
  'To start from an existing SVG icon, pass its path segments to gridsmith_import for a rounded spec.';

/** Builds the MCP server with its four tools registered. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'gridsmith', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerGuide(server);
  registerRender(server);
  registerExport(server);
  registerImport(server);
  return server;
}
