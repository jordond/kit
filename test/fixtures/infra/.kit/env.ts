import { z } from 'zod'

export default z.object({
  API_SECRET: z.string().min(16).meta({ description: 'shared worker secret', generate: 'hex' }),
  PUBLIC_URL: z.url().meta({ secret: false }),
  OPTIONAL_KEY: z.string().optional(),
  DEPLOY_TOKEN: z.string().optional(),
  MODE: z.enum(['dev', 'prod']).default('dev').meta({ secret: false }),
})
