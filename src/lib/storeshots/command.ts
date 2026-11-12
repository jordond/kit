import { KitError } from '../errors'
import type { ExportShots } from './types'

/** `kit shots export`: plan, render in headless Chrome, write to the store listing dirs. */
export const exportShots: ExportShots = async (_ctx, _opts) => {
  throw new KitError('kit shots export is not implemented yet')
}
