import { z } from 'zod'

export const verbs = ['lint', 'format', 'typecheck', 'test', 'build', 'dev', 'deploy'] as const
export type Verb = (typeof verbs)[number]

export const kinds = ['gradle', 'worker', 'vite', 'astro', 'docker', 'custom'] as const
export type Kind = (typeof kinds)[number]

export const tracks = ['internal', 'alpha', 'beta', 'prod'] as const
export type Track = (typeof tracks)[number]

/** A command string, or a list run in order. `false` turns a kind's default off. */
const command = z.union([z.string(), z.array(z.string()), z.literal(false)])
export type CommandValue = z.infer<typeof command>

const verbOverrides = Object.fromEntries(verbs.map((v) => [v, command.optional()])) as Record<
  Verb,
  z.ZodOptional<typeof command>
>

const deploy = z.union([
  command,
  z
    .object({
      /** Deploy command; defaults to the kind's. */
      run: command.optional(),
      /** kit commands run first, e.g. `env sync`. */
      before: z.array(z.string()).optional(),
    })
    .strict(),
])

const target = z
  .object({
    kind: z.enum(kinds),
    dir: z.string(),
    envs: z.array(z.string()).optional(),
    ...verbOverrides,
    deploy: deploy.optional(),
  })
  .strict()
export type TargetConfig = z.output<typeof target>

const workspace = z
  .object({
    ...verbOverrides,
    /** Commands run before lint, typecheck, test and build when the workspace runs (codegen). */
    prepare: command.optional(),
  })
  .strict()

export const configSchema = z
  .object({
    name: z.string().min(1),
    gradle: z
      .object({
        root: z.string(),
        /** Tasks `kit init` runs to fetch the wrapper and dependencies (`:shared:dependencies`). */
        init: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict()
      .optional(),
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
                /** Static local-only lines (`ENVIRONMENT: 'dev'`); never pushed. */
                vars: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .optional(),
        workerSecrets: z.record(z.string(), z.array(z.string())).optional(),
        githubSecrets: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    workspace: workspace.optional(),
    targets: z.record(z.string(), target).default({}),
    cloudflare: z
      .object({
        accountId: z.string().optional(),
        d1: z
          .record(
            z.string(),
            z
              .object({
                name: z.string(),
                target: z.string(),
                /** Used when `kit db` gets no --db and several are configured. */
                default: z.boolean().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    release: z
      .object({
        branches: z.array(z.string()).optional(),
        notes: z.object({ maxLength: z.number().int().positive().optional() }).strict().optional(),
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
                  tracks: z.array(z.enum(tracks)),
                }),
              )
              .optional(),
          })
          .strict()
          .optional(),
        services: z
          .record(
            z.string(),
            z.object({ versionKey: z.string(), build: z.string().optional(), deploy: z.string() }).strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [name, d] of Object.entries(c.cloudflare?.d1 ?? {})) {
      if (!c.targets[d.target]) {
        ctx.addIssue({
          code: 'custom',
          path: ['cloudflare', 'd1', name, 'target'],
          message: `Unknown target "${d.target}"`,
        })
      }
    }
    const defaults = Object.entries(c.cloudflare?.d1 ?? {}).filter(([, d]) => d.default)
    if (defaults.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['cloudflare', 'd1'],
        message: `Only one database can be the default (${defaults.map(([k]) => k).join(', ')})`,
      })
    }
    if (c.targets.workspace) {
      ctx.addIssue({ code: 'custom', path: ['targets', 'workspace'], message: '"workspace" is reserved' })
    }
  })

export type KitConfigInput = z.input<typeof configSchema>
export type KitConfig = z.output<typeof configSchema>
