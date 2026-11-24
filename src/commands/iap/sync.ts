import { defineCommand } from '../../cli/command'
import { iapArgs } from './_args'

export default defineCommand({
  description: 'Create and update in-app products in every store from the product file; never deletes',
  group: 'Release',
  args: iapArgs,
  examples:
    'kit iap sync --dry-run\nkit iap sync\nkit iap sync --store play --yes\nkit iap sync --product membership_card --json --yes',
  async run(ctx) {
    const { runIap } = await import('../../lib/iap/sync')
    await runIap(ctx, { mode: 'sync', stores: ctx.args.store ?? [], products: ctx.args.product ?? [] })
  },
})
