import type { Args } from 'gunshi'

/** `--store` and `--product`, shared by status and sync. */
export const iapArgs = {
  store: {
    type: 'string',
    short: 's',
    multiple: true,
    description: 'Only this store: apple, play or revenuecat; repeatable (default: every configured one)',
  },
  product: {
    type: 'string',
    short: 'p',
    multiple: true,
    description: 'Only this product id from the file; repeatable',
  },
} as const satisfies Args
