import { createContactHandler } from '../_shared/integration-handlers.js';

Deno.serve(createContactHandler({ env: (name: string) => Deno.env.get(name) }));
