import baseSetup from '@celo/dev-utils/lib/ganache-setup'
// Has to import the matchers somewhere so that typescript knows the matchers have been made available
import _unused from '@celo/dev-utils/lib/matchers'
import { waitForPortOpen } from '@celo/dev-utils/lib/network'
import * as path from 'path'

// Warning: There should be an unused import of '@celo/dev-utils/lib/matchers' above.
// If there is not, then your editor probably deleted it automatically.

const USE_GANACHE = process.env.NO_GANACHE?.toLowerCase() !== 'true'

export default async function globalSetup() {
  if (USE_GANACHE) {
    console.log('\nstarting ganache... set NO_GANACHE=true to disable')
    const chainDataPath = path.join(
      path.dirname(require.resolve('@celo/celo-devchain')),
      '../chains'
    )
    await baseSetup(path.resolve(chainDataPath), 'v10.tar.gz', {
      from_targz: true,
    })
    await waitForPortOpen('localhost', 8545, 60)
    console.log('...ganache started')
  } else {
    console.log('skipping ganache setup')
  }
}
