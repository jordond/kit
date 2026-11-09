import { z } from 'zod'

export const verbs = ['lint', 'format', 'typecheck', 'test', 'build', 'dev', 'deploy'] as const
export type Verb = (typeof verbs)[number]

export const kinds = ['gradle', 'worker', 'vite', 'astro', 'docker', 'custom'] as const
export type Kind = (typeof kinds)[number]

const command = z.union([z.string(), z.array(z.string())])
const verbOverrides = Object.fromEntries(verbs.map((v) => [v, command.optional()])) as Record<
  Verb,
  z.ZodOptional<typeof command>
>

const target = z
  .object({
    kind: z.enum(kinds),
    dir: z.string(),
    envs: z.array(z.string()).optional(),
    ...verbOverrides,
    deploy: z.union([command, z.object({ before: z.array(z.string()).optional() })]).optional(),
  })
  .strict()

export const configSchema = z
  .object({
    name: z.string().min(1),
    gradle: z.object({ root: z.string() }).strict().optional(),
    versions: z
      .object({
        file: z.string(),
        keys: z.record(z.string(), z.string()),
      })
      .strict()
      .optional(),
    env: z
      .object({
        schema: z.string().optional(),
        outputs: z
          .record(
            z.string(),
            z
              .object({
                pick: z.array(z.string()).optional(),
                rename: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
        workerSecrets: z.record(z.string(), z.array(z.string())).optional(),
        githubSecrets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    workspace: z.object(verbOverrides).strict().optional(),
    targets: z.record(z.string(), target).default({}),
    release: z
      .object({
        branches: z.array(z.string()).optional(),
        preflight: z.array(z.string()).optional(),
        ios: z
          .object({
            bundleIds: z.array(z.string()).min(1),
            project: z.string(),
            scheme: z.string(),
            output: z.string(),
            teamId: z.string().optional(),
            testflightGroups: z.object({ alpha: z.string(), beta: z.string() }).partial().optional(),
            sentry: z.object({ org: z.string(), project: z.string() }).strict().optional(),
          })
          .strict()
          .optional(),
        android: z
          .object({
            packageName: z.string(),
            module: z.string(),
            prodRollout: z.number().gt(0).lte(1).optional(),
            gates: z
              .array(
                z.object({
                  task: z.string(),
                  tracks: z.array(z.enum(['internal', 'alpha', 'beta', 'prod'])),
                }),
              )
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export type KitConfigInput = z.input<typeof configSchema>
export type KitConfig = z.output<typeof configSchema>
