import { defineCommand } from '../../cli/command'
import { iapArgs } from './_args'

export default defineCommand({
  description: 'Compare the product file with App Store Connect, Google Play and RevenueCat; writes nothing',
  group: 'Release',
  args: iapArgs,
  examples: 'kit iap status\nkit iap status --store apple\nkit iap status --product membership_card --json',
  async run(ctx) {
    const { runIap } = await import('../../lib/iap/sync')
    await runIap(ctx, { mode: 'status', stores: ctx.args.store ?? [], products: ctx.args.product ?? [] })
  },
})
