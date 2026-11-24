// Writes schemas/iap.schema.json from the product-file zod schema (src/lib/iap/file.ts).
// `bun run build` runs it; test/unit/iap-file.test.ts fails when the committed copy is stale.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { iapJsonSchema } from '../src/lib/iap/file'

writeFileSync(join(import.meta.dir, '../schemas/iap.schema.json'), iapJsonSchema())
