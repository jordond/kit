/** The flags `kit qa` and `kit shots` share. */
export const suiteArgs = {
  suite: { type: 'string', description: 'Run this maestro.suites entry' },
  device: { type: 'string', description: 'Simulator UDID or adb serial (default: the running one)' },
  'no-build': { type: 'boolean', description: 'Install the newest existing build' },
  fixture: { type: 'string', description: "Load this fixture instead of the suite's" },
  'no-fixture': { type: 'boolean', description: 'Load no fixture' },
} as const
