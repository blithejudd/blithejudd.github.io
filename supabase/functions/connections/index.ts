import { createConnectionsHandler } from '../_shared/integration-handlers.js';

// Auth validates the JWT; the owner RPC authorizes every non-preflight request.
Deno.serve(createConnectionsHandler({ env: (name: string) => Deno.env.get(name) }));
