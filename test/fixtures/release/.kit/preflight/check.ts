// A preflight that fails when PREFLIGHT_FAIL is set; skippable with --skip demo.
export default {
  title: 'demo check',
  skipFlag: 'demo',
  check(_ctx: unknown, info: { platform: string; track: string; version: string }) {
    console.log('✓ demo preflight says hi')
    if (process.env.PREFLIGHT_FAIL)
      throw new Error(`demo failed for ${info.platform} ${info.track} ${info.version}`)
  },
}
